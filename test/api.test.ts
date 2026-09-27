/**
 * Integration tests over the real HTTP surface.
 *
 * These boot the actual Fastify app against a real Postgres and an offline
 * fake provider, so they cover routing, auth, problem JSON, the spec cache and
 * the queue without needing a network or an API key.
 *
 * Skipped automatically when no database is reachable, so `npm test` still
 * works on a fresh checkout.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PH_SEED_TEMPLATES ??= 'false';
process.env.DATABASE_URL ??= 'postgres://pigeonhole:devpass@localhost:55432/pigeonhole';
process.env.PH_ADMIN_TOKEN ??= 'test-admin-token';
process.env.LOG_LEVEL ??= 'error';

const TOKEN = process.env.PH_ADMIN_TOKEN;
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

let app: any;
let available = false;

before(async () => {
  const { waitForDatabase } = await import('../src/db/pool.ts');
  try {
    await waitForDatabase(5000);
    available = true;
  } catch {
    return; // no database: every test below skips
  }
  const { migrate } = await import('../src/db/migrate.ts');
  await migrate();
  const { setProvider } = await import('../src/provider/index.ts');
  const { createFakeProvider } = await import('./fake-provider.ts');
  setProvider(createFakeProvider());
  const { startBus } = await import('../src/cache/bus.ts');
  await startBus();
  const { buildServer } = await import('../src/server/app.ts');
  app = await buildServer();
  await app.ready();
});

after(async () => {
  if (!available) return;
  await app?.close();
  const { stopBus } = await import('../src/cache/bus.ts');
  const { closeDb } = await import('../src/db/pool.ts');
  await stopBus();
  await closeDb();
});

const id = `itest-${Date.now().toString(36)}`;

const SPEC = `
pigeonhole: 1
id: ${id}
description: An integration test pipeline.
input:
  type: object
  properties: { body: { type: string } }
  required: [body]
nodes:
  topic:
    type: choice
    instructions: Which topic does this message concern?
    criteria:
      billing: { what: "Charges, invoices and payment problems." }
      shipping: { what: "Delivery, tracking and lost packages." }
      other: { what: "Anything else at all." }
    min_confidence: 0.2
    on_low_confidence: human_review
  urgent:
    type: noul
    instructions: The sender needs an answer today.
  route:
    type: rule
    expr: 'urgent.p > 0.6 ? topic.choice + "-urgent" : topic.choice'
output:
  topic: topic.choice
  route: route.value
  needs_review: topic.low_confidence
tests:
  - input: { body: "I was charged twice for my invoice" }
    expect: { topic: billing }
`;

describe('control plane', () => {
  test('rejects a request with no credential when a token is configured', async (t) => {
    if (!available) return t.skip('no database');
    const res = await app.inject({ method: 'GET', url: '/v1/pipelines' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['content-type']?.split(';')[0], 'application/problem+json');
    assert.equal(res.json().code, 'unauthorized');
  });

  test('health stays open, because Docker needs it', async (t) => {
    if (!available) return t.skip('no database');
    assert.equal((await app.inject({ url: '/healthz' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/readyz' })).statusCode, 200);
  });

  test('creates a pipeline, publishes it, and serves it immediately', async (t) => {
    if (!available) return t.skip('no database');

    const created = await app.inject({
      method: 'POST', url: '/v1/pipelines', headers: auth,
      payload: { id, spec_yaml: SPEC },
    });
    assert.equal(created.statusCode, 201);

    const published = await app.inject({
      method: 'POST', url: `/v1/pipelines/${id}/versions`, headers: auth, payload: {},
    });
    assert.equal(published.statusCode, 201);
    assert.equal(published.json().version, 1);

    // Publish is immediately consistent here: no propagation window, so a
    // classify straight after a publish must already see the new version.
    const classified = await app.inject({
      method: 'POST', url: `/v1/classify/${id}`, headers: auth,
      payload: { input: { body: 'I was charged twice for my invoice' } },
    });
    assert.equal(classified.statusCode, 200);
    const body = classified.json();
    assert.equal(body.version, 1);
    assert.equal(body.usage.decision_calls, 1, 'two model nodes, one call');
    assert.ok(['billing', 'shipping', 'other'].includes(body.output.topic));
    assert.equal(typeof body.output.needs_review, 'boolean');
    assert.equal(body.output.route, body.output.topic + (body.nodes.urgent.p > 0.6 ? '-urgent' : ''));
  });

  test('a bad input is a 400 problem, not a 500', async (t) => {
    if (!available) return t.skip('no database');
    const res = await app.inject({
      method: 'POST', url: `/v1/classify/${id}`, headers: auth,
      payload: { input: { wrong: 'field' } },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'input_invalid');
  });

  test('a missing pipeline is a 404 problem', async (t) => {
    if (!available) return t.skip('no database');
    const res = await app.inject({
      method: 'POST', url: '/v1/classify/no-such-pipeline', headers: auth,
      payload: { input: { body: 'x' } },
    });
    assert.equal(res.statusCode, 404);
  });

  test('an unbounded batch is processed with a concurrency limit', async (t) => {
    if (!available) return t.skip('no database');
    const inputs = Array.from({ length: 25 }, (_, i) => ({ body: `message number ${i} about an invoice` }));
    const res = await app.inject({
      method: 'POST', url: `/v1/classify/${id}/batch`, headers: auth,
      payload: { inputs },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.count, 25);
    assert.equal(body.ok, 25);
    assert.equal(body.failed, 0);
  });

  test('an eval reports accuracy, calibration and the resolved model', async (t) => {
    if (!available) return t.skip('no database');
    const res = await app.inject({
      method: 'POST', url: `/v1/pipelines/${id}/evals?wait=true`, headers: auth, payload: {},
    });
    assert.equal(res.statusCode, 200);
    const report = res.json();
    assert.ok(report.cases >= 1);
    assert.ok(report.accuracy >= 0 && report.accuracy <= 1);
    assert.ok(Array.isArray(report.calibration));
  });

  test('a pipeline reports the model its served version runs on', async (t) => {
    if (!available) return t.skip('no database');
    const res = await app.inject({ method: 'GET', url: `/v1/pipelines/${id}`, headers: auth });
    assert.equal(res.json().pipeline.runtime_model, 'jev-latest');
  });

  test('the generated OpenAPI types the output as a union', async (t) => {
    if (!available) return t.skip('no database');
    const res = await app.inject({ method: 'GET', url: `/v1/pipelines/${id}/openapi.json`, headers: auth });
    assert.equal(res.statusCode, 200);
    const doc = res.json();
    assert.equal(doc.openapi, '3.1.0');
    assert.deepEqual(
      doc.components.schemas.Output.properties.topic.enum.filter(Boolean).sort(),
      ['billing', 'other', 'shipping'],
    );
  });

  test('an invalid spec is rejected with the failing paths', async (t) => {
    if (!available) return t.skip('no database');
    const res = await app.inject({
      method: 'PUT', url: `/v1/pipelines/${id}`, headers: auth,
      payload: { spec_yaml: 'pigeonhole: 1\nid: x\nnodes: {}\noutput: {}\n' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'spec_invalid');
  });

  test('the status endpoint reports the models', async (t) => {
    if (!available) return t.skip('no database');
    const res = await app.inject({ method: 'GET', url: '/v1/status', headers: auth });
    assert.equal(res.json().runtime_model, 'jev-latest');
  });
});

describe('mcp', () => {
  test('lists published pipelines as tools and calls one', async (t) => {
    if (!available) return t.skip('no database');

    const list = await app.inject({
      method: 'POST', url: '/mcp', headers: auth,
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const tools = list.json().result.tools;
    const tool = tools.find((x: any) => x.name === `classify_${id.replace(/-/g, '_')}`);
    assert.ok(tool, 'the published pipeline is exposed as a tool');

    const called = await app.inject({
      method: 'POST', url: '/mcp', headers: auth,
      payload: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: tool.name, arguments: { body: 'my invoice was charged twice' } },
      },
    });
    const result = called.json().result;
    assert.ok(result.structuredContent.output.topic);
  });

  test('a notification is accepted with no response body', async (t) => {
    if (!available) return t.skip('no database');
    const res = await app.inject({
      method: 'POST', url: '/mcp', headers: auth,
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    assert.equal(res.statusCode, 202);
  });
});

describe('the feedback loop', () => {
  test('a correction becomes a test case', async (t) => {
    if (!available) return t.skip('no database');

    // Retain every run so there is something to correct.
    const spec = SPEC.replace(
      'output:',
      'compose:\n  logging:\n    retain: all\noutput:',
    );
    await app.inject({ method: 'PUT', url: `/v1/pipelines/${id}`, headers: auth, payload: { spec_yaml: spec } });
    await app.inject({ method: 'POST', url: `/v1/pipelines/${id}/versions`, headers: auth, payload: {} });

    const run = await app.inject({
      method: 'POST', url: `/v1/classify/${id}`, headers: auth,
      payload: { input: { body: 'where is my parcel' } },
    });
    const runId = run.json().run_id;

    // Persistence is deliberately off the response path, so give it a moment.
    await new Promise((r) => setTimeout(r, 500));

    const feedback = await app.inject({
      method: 'POST', url: `/v1/runs/${runId}/feedback`, headers: auth,
      payload: { correct_output: { topic: 'shipping' }, is_correct: false, promote_to_test: true },
    });
    assert.equal(feedback.statusCode, 200);
    assert.ok(feedback.json().promoted_test_id, 'the correction became a test case');
  });
});

describe('the compile progress stream', () => {
  /**
   * EventSource cannot send an Authorization header. When the stream 401s the
   * builder sits on "queued" forever and the compiled YAML — which did get
   * written — never reaches the screen, so this path is load-bearing.
   *
   * The compile is marked finished before the stream is opened purely so the
   * route replays state and closes; the auth decision under test happens
   * before any of that.
   */
  async function startedCompile(description: string) {
    const started = await app.inject({
      method: 'POST', url: `/v1/pipelines/${id}/compile`, headers: auth, payload: { description },
    });
    assert.equal(started.statusCode, 202);
    const repo = await import('../src/db/repo.ts');
    await repo.setCompileStatus(started.json().compile_id, 'failed', { error: 'stopped for the test' });
    return started.json();
  }

  test('the ticket in events_url opens the stream, and nothing else does', async (t) => {
    if (!available) return t.skip('no database');
    await app.inject({ method: 'PUT', url: `/v1/pipelines/${id}`, headers: auth, payload: { spec_yaml: SPEC } });

    const { events_url: eventsUrl } = await startedCompile('A pipeline that sorts inbound support mail by topic.');
    assert.match(eventsUrl, /\?ticket=/, 'the stream URL carries a ticket');

    // No header, but a valid ticket: exactly what the browser sends.
    const streamed = await app.inject({ method: 'GET', url: eventsUrl });
    assert.equal(streamed.statusCode, 200);
    assert.match(streamed.headers['content-type'] as string, /text\/event-stream/);

    const bare = await app.inject({ method: 'GET', url: eventsUrl.split('?')[0] });
    assert.equal(bare.statusCode, 401, 'the same URL without a ticket is refused');

    const forged = await app.inject({ method: 'GET', url: `${eventsUrl.split('?')[0]}?ticket=not-a-real-ticket` });
    assert.equal(forged.statusCode, 401, 'a made-up ticket is refused');
  });

  test('a ticket unlocks only the compile it was minted for', async (t) => {
    if (!available) return t.skip('no database');

    const a = await startedCompile('First compile, used only to mint a ticket.');
    const b = await startedCompile('Second compile, a different run entirely.');
    const ticketA = a.events_url.split('ticket=')[1];

    const crossed = await app.inject({
      method: 'GET', url: `/v1/pipelines/${id}/compile/${b.compile_id}/events?ticket=${ticketA}`,
    });
    assert.equal(crossed.statusCode, 401, 'a ticket is scoped to one compile');
  });

  test('a ticket is not a credential for anything else', async (t) => {
    if (!available) return t.skip('no database');

    const { events_url: eventsUrl } = await startedCompile('A compile whose ticket we then try to misuse.');
    const ticket = eventsUrl.split('ticket=')[1];

    for (const url of [`/v1/pipelines?ticket=${ticket}`, `/v1/pipelines/${id}?ticket=${ticket}`]) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 401, `${url} must still need a bearer token`);
    }
  });
});

describe('API key revocation', () => {
  /** A key is revoked because it leaked, so it has to stop working at once. */
  test('a revoked key stops working immediately', async (t) => {
    if (!available) return t.skip('no database');

    const created = await app.inject({
      method: 'POST', url: '/v1/keys', headers: auth,
      payload: { name: 'revocation test', scopes: ['admin', 'classify'] },
    });
    assert.equal(created.statusCode, 201);
    const { key, id: keyId } = created.json();
    const asKey = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

    const before = await app.inject({ method: 'GET', url: '/v1/pipelines', headers: asKey });
    assert.equal(before.statusCode, 200);

    // No content-type: a DELETE carries no body.
    const revoked = await app.inject({
      method: 'DELETE', url: `/v1/keys/${keyId}`, headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(revoked.statusCode, 200, revoked.body);

    const after = await app.inject({ method: 'GET', url: '/v1/pipelines', headers: asKey });
    assert.equal(after.statusCode, 401, 'the revoked key must not keep working');
  });
});

describe('an eval that cannot run a single case', () => {
  /**
   * Stored as a failed run with no accuracy — never as 0%. A 0% here would
   * become the version's score, and on a nightly run read as a 100-point drift.
   */
  test('is recorded as failed, and leaves the version score alone', async (t) => {
    if (!available) return t.skip('no database');
    const pid = `unrunnable-${Date.now()}`;
    const yaml = `
pigeonhole: 1
id: ${pid}
input: { type: object, properties: { body: { type: string } }, required: [body] }
nodes:
  topic:
    type: choice
    instructions: What is this about?
    criteria: { billing: { what: Money }, other: { what: Anything else } }
output:
  topic: topic.choice
tests:
  - name: missing-required-field
    input: { subject: "no body here" }
    expect: { topic: other }
`;
    assert.equal((await app.inject({ method: 'POST', url: '/v1/pipelines', headers: auth, payload: { id: pid, spec_yaml: yaml } })).statusCode, 201);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/pipelines/${pid}/versions`, headers: auth, payload: {} })).statusCode, 201);

    const res = await app.inject({ method: 'POST', url: `/v1/pipelines/${pid}/evals?wait=true`, headers: auth, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    const report = res.json();
    assert.equal(report.accuracy, null);
    assert.equal(report.errored, 1);
    assert.deepEqual(report.error_kinds, { input_invalid: 1 });

    const repo = await import('../src/db/repo.ts');
    const [stored] = await repo.listEvalRuns(pid) as any[];
    assert.equal(stored.status, 'failed');
    assert.equal(stored.accuracy, null);
    assert.match(stored.error, /1\/1 cases could not run/);

    const detail = (await app.inject({ method: 'GET', url: `/v1/pipelines/${pid}`, headers: auth })).json();
    const v1 = detail.versions.find((v: any) => v.version === 1);
    assert.equal(v1.eval_summary ?? null, null, 'a run that measured nothing must not become the version score');
  });
});

describe('the builder works on the newest of draft and published version', () => {
  const wid = `${id}-working`;
  const spec = (instructions: string) => SPEC.replace(`id: ${id}`, `id: ${wid}`)
    .replace('Which topic does this message concern?', instructions);

  test('a draft with unpublished changes is what try and eval run; otherwise the latest version', async (t) => {
    if (!available) return t.skip('no database');
    const created = await app.inject({
      method: 'POST', url: '/v1/pipelines', headers: auth,
      payload: { id: wid, spec_yaml: spec('Which topic does this message concern?') },
    });
    assert.equal(created.statusCode, 201);
    let detail = (await app.inject({ method: 'GET', url: `/v1/pipelines/${wid}`, headers: auth })).json();
    assert.deepEqual(detail.working, { source: 'draft', version: null }, 'unpublished: the draft');

    await app.inject({ method: 'POST', url: `/v1/pipelines/${wid}/versions`, headers: auth, payload: {} });
    detail = (await app.inject({ method: 'GET', url: `/v1/pipelines/${wid}`, headers: auth })).json();
    assert.deepEqual(detail.working, { source: 'version', version: 1 }, 'just published: the version');

    const tried = await app.inject({
      method: 'POST', url: `/v1/pipelines/${wid}/try`, headers: auth, payload: { input: { body: 'my invoice is wrong' } },
    });
    assert.equal(tried.json().target, 'v1');
    const evaluated = (await app.inject({
      method: 'POST', url: `/v1/pipelines/${wid}/evals?wait=true`, headers: auth, payload: { target: 'working' },
    })).json();
    assert.equal(evaluated.target, 'v1');
    assert.equal(evaluated.results.length, evaluated.cases, 'every case is returned, passes included');
    assert.ok(evaluated.results.every((r: any) => 'passed' in r && r.actual));

    await app.inject({
      method: 'PUT', url: `/v1/pipelines/${wid}`, headers: auth,
      payload: { spec_yaml: spec('What is this message about?') },
    });
    detail = (await app.inject({ method: 'GET', url: `/v1/pipelines/${wid}`, headers: auth })).json();
    assert.deepEqual(detail.working, { source: 'draft', version: null }, 'edited after publishing: the draft');

    const triedDraft = await app.inject({
      method: 'POST', url: `/v1/pipelines/${wid}/try`, headers: auth, payload: { input: { body: 'my invoice is wrong' } },
    });
    assert.equal(triedDraft.statusCode, 200);
    assert.equal(triedDraft.json().target, 'draft');
    assert.ok(triedDraft.json().output);
    const draftEval = (await app.inject({
      method: 'POST', url: `/v1/pipelines/${wid}/evals?wait=true`, headers: auth, payload: { target: 'working' },
    })).json();
    assert.equal(draftEval.target, 'draft');
    assert.equal(draftEval.eval_id, undefined, 'a draft eval is not stored');
  });
});
