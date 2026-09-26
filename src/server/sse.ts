/**
 * Server-sent events.
 *
 * Compile progress is published by the job to the bus and relayed here, so
 * the browser sees "sharpening criteria (2/4)" and "dry run: 22/30 correct"
 * as they happen rather than by polling.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Identity } from './auth.js';
import { onBus, type BusMessage } from '../cache/bus.js';
import { log } from '../log.js';

export interface SseStream {
  send(event: string, data: unknown): void;
  close(): void;
}

export function openSse(reply: FastifyReply): SseStream {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // A reverse proxy in front must not buffer this.
    'x-accel-buffering': 'no',
  });
  reply.raw.write(': connected\n\n');

  // A comment frame every 20s keeps intermediaries from closing an idle stream.
  const heartbeat = setInterval(() => {
    try {
      reply.raw.write(': keepalive\n\n');
    } catch {
      /* the close handler will clean up */
    }
  }, 20_000);
  heartbeat.unref?.();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      reply.raw.end();
    } catch {
      /* already gone */
    }
  };

  reply.raw.on('close', close);

  return {
    send(event, data) {
      if (closed) return;
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (err) {
        log.debug('sse write failed', { error: (err as Error).message });
        close();
      }
    },
    close,
  };
}

/** Relays compile progress for one compile id to one browser. */
export function streamCompileProgress(stream: SseStream, compileId: string, onDone: () => void): () => void {
  return onBus((msg: BusMessage) => {
    if (msg.type !== 'compile_progress' || msg.compile_id !== compileId) return;
    stream.send('progress', msg.payload);
    const pass = (msg.payload as { pass?: string }).pass;
    if (pass === 'done' || pass === 'failed') {
      stream.send('done', msg.payload);
      onDone();
    }
  });
}

/**
 * Stream tickets.
 *
 * EventSource cannot send an Authorization header, so the stream cannot be
 * authenticated the way every other endpoint is. The POST that starts the
 * compile *is* authenticated, so it mints a ticket that is good for that one
 * compile id and nothing else, and the browser puts that in the stream URL.
 *
 * Passing the admin token as a query parameter would have been less code, but
 * it would then sit in proxy access logs, browser history and any Referer for
 * as long as those are kept. A ticket that expires in ten minutes and unlocks
 * one compile's progress messages is a much smaller thing to leak.
 *
 * Tickets stay valid for their whole TTL rather than being single-use, because
 * EventSource reconnects on its own whenever the connection drops and a
 * one-shot ticket would turn every dropped frame into a dead stream.
 */
const TICKET_TTL_SECONDS = 600;
const tickets = new Map<string, { compileId: string; expiresAt: number }>();

export function mintSseTicket(compileId: string): string {
  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, { compileId, expiresAt: Date.now() + TICKET_TTL_SECONDS * 1000 });
  sweepTickets();
  return ticket;
}

function sseTicketMatches(ticket: string, compileId: string): boolean {
  const entry = tickets.get(ticket);
  return Boolean(entry && entry.expiresAt > Date.now() && entry.compileId === compileId);
}

function sweepTickets(): void {
  if (tickets.size < 256) return;
  const now = Date.now();
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(ticket);
  }
}

/**
 * The identity a compile progress stream is allowed to run as, or null if this
 * is not a ticketed stream request. Checked by authGuard before bearer-token
 * auth, because more than one route hook guards these URLs and only the first
 * one to match gets a say.
 *
 * A ticket only ever resolves for the exact URL shape it was minted for, so it
 * cannot be replayed against any other endpoint.
 */
export function sseTicketIdentity(req: FastifyRequest): Identity | null {
  const [path, search] = req.url.split('?');
  const route = /\/compile\/([^/]+)\/events$/.exec(path);
  if (!route) return null;
  const ticket = new URLSearchParams(search ?? '').get('ticket');
  if (!ticket) return null;
  if (!sseTicketMatches(ticket, decodeURIComponent(route[1]))) return null;
  return { kind: 'admin', name: 'compile stream ticket', scopes: ['admin'], pipelines: null };
}
