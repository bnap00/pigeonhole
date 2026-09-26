/**
 * Webhook delivery, for drift alerts and async classify results.
 *
 * Deliveries go through the queue with retries and a dead letter queue, so an
 * alert is not lost because a receiver happened to be down.
 */
import { createHmac } from 'node:crypto';
import { config } from '../config.js';

export interface WebhookDelivery {
  url: string;
  secret?: string | null;
  event: string;
  payload: Record<string, unknown>;
}

export async function deliverWebhook(delivery: WebhookDelivery): Promise<void> {
  const body = JSON.stringify({
    event: delivery.event,
    sent_at: new Date().toISOString(),
    data: delivery.payload,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': `pigeonhole/${config.version}`,
    'x-pigeonhole-event': delivery.event,
  };
  if (delivery.secret) {
    // HMAC over the exact body, so a receiver can verify the payload came
    // from this stack and was not modified.
    headers['x-pigeonhole-signature'] = `sha256=${createHmac('sha256', delivery.secret).update(body).digest('hex')}`;
  }

  const res = await fetch(delivery.url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // Thrown so the queue retries with backoff and dead-letters after five.
    throw new Error(`webhook ${delivery.url} returned ${res.status}`);
  }
}
