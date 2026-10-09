#!/usr/bin/env node
/**
 * The Pigeonhole CLI.
 *
 * `--server` points it at a running app (http://localhost:8080 by default).
 * `mcp` talks to the database directly, so it needs DATABASE_URL.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSpecYaml, specToYaml, lint } from '../spec/parse.js';
import type { PipelineSpec } from '../spec/types.js';

const SPEC_DIR = process.env.PH_LOCAL_SPEC_DIR ?? 'pipelines';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { command: positional.shift() ?? 'help', positional, flags };
}

const args = parseArgs(process.argv.slice(2));

const server = String(args.flags.server ?? process.env.PIGEONHOLE_SERVER ?? 'http://localhost:8080').replace(/\/+$/, '');
const token = String(args.flags.token ?? process.env.PIGEONHOLE_TOKEN ?? process.env.PH_ADMIN_TOKEN ?? '');

const out = (text: string) => process.stdout.write(`${text}\n`);
const err = (text: string) => process.stderr.write(`${text}\n`);

function die(message: string, code = 1): never {
  err(`error: ${message}`);
  process.exit(code);
}

async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${server}${path}`, { ...options, headers });
  } catch (e) {
    die(`cannot reach ${server}: ${(e as Error).message}\nIs the app up? Try: make up`);
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = body?.detail ?? `request failed (${res.status})`;
    die(`${detail}${body?.hint ? `\nhint: ${body.hint}` : ''}`);
  }
  return body as T;
}

// -------------------------------------------------------------- local files

async function localSpecs(): Promise<{ file: string; spec: PipelineSpec }[]> {
  if (!existsSync(SPEC_DIR)) return [];
  const files = (await readdir(SPEC_DIR)).filter((f) => /\.ya?ml$/i.test(f));
  const out: { file: string; spec: PipelineSpec }[] = [];
  for (const file of files) {
    const text = await readFile(join(SPEC_DIR, file), 'utf8');
    out.push({ file: join(SPEC_DIR, file), spec: parseSpecYaml(text) });
  }
  return out;
}

async function writeSpec(spec: PipelineSpec): Promise<string> {
  await mkdir(SPEC_DIR, { recursive: true });
  const path = join(SPEC_DIR, `${spec.id}.yaml`);
  await writeFile(path, specToYaml(spec), 'utf8');
  return path;
}

// ------------------------------------------------------------------ commands

const COMMANDS: Record<string, () => Promise<void>> = {
  async help() {
    out(`pigeonhole — describe a classifier in English, get a typed, tested, versioned API

Usage: pigeonhole <command> [options]

Authoring
  init "<description>" [--id <id>]     Compile a description into ${SPEC_DIR}/<id>.yaml
  edit <pipeline> "<instruction>"      Incremental edit, e.g. "split billing into refunds and invoices"
  lint [pipeline]                      Validate local specs and show warnings

Running
  classify <pipeline> "<text>"         One-off classification
  test [pipeline]                      Run test cases; non-zero exit on regression (for CI)
  diff <pipeline> --models a,b         Compare two models or versions on the test set
  bench [pipeline…] --models a,b,c     Accuracy, latency and cost per model, one case at a time

Syncing
  push [pipeline]                      Publish local spec files as new versions
  pull [pipeline]                      Write server specs to ${SPEC_DIR}/

Agents
  mcp                                  MCP server over stdio, for local agents

Operations
  check                                Database, migrations and a live provider call

Options
  --server <url>     Target server (default ${server})
  --token <token>    Bearer token (or PIGEONHOLE_TOKEN)
  --json             Machine-readable output where it makes sense`);
  },

  async init() {
    const description = args.positional.join(' ').trim();
    if (!description) die('give a description: pigeonhole init "route tickets to returns, shipping or billing"');

    const id = String(args.flags.id ?? slugify(description));
    out(`compiling "${id}"…`);

    const existing = await call<{ pipelines: { id: string }[] }>('/v1/pipelines');
    if (!existing.pipelines.some((p) => p.id === id)) {
      await call('/v1/pipelines', { method: 'POST', body: JSON.stringify({ id, description }) });
    }

    const started = await call<{ compile_id: string; cost_estimate_usd: number }>(
      `/v1/pipelines/${id}/compile`,
      { method: 'POST', body: JSON.stringify({ description }) },
    );
    out(`compile ${started.compile_id} queued (estimated $${started.cost_estimate_usd.toFixed(3)})`);

    const finished = await pollCompile(id, started.compile_id);
    if (finished.status !== 'done') die(finished.error ?? 'compile failed');

    const spec = finished.spec as PipelineSpec;
    const path = await writeSpec(spec);
    out(`\nwrote ${path}`);
    out(`${Object.keys(spec.nodes).length} node(s), ${spec.tests?.length ?? 0} test case(s)`);
    for (const warning of lint(spec)) out(`  warning [${warning.code}] ${warning.message}`);
    out(`\nnext: pigeonhole test ${id} && pigeonhole push ${id}`);
  },

  async edit() {
    const [pipeline, ...rest] = args.positional;
    const instruction = rest.join(' ').trim();
    if (!pipeline || !instruction) die('usage: pigeonhole edit <pipeline> "<instruction>"');

    const started = await call<{ compile_id: string }>(`/v1/pipelines/${pipeline}/compile`, {
      method: 'POST',
      body: JSON.stringify({ instruction }),
    });
    const finished = await pollCompile(pipeline, started.compile_id);
    if (finished.status !== 'done') die(finished.error ?? 'compile failed');

    out(`\n${(finished.diff as { summary?: string })?.summary ?? 'changes ready'}`);
    if (args.flags.accept) {
      await call(`/v1/pipelines/${pipeline}/compile/${started.compile_id}/accept`, { method: 'POST' });
      const path = await writeSpec(finished.spec as PipelineSpec);
      out(`accepted; wrote ${path}`);
    } else {
      out('run again with --accept to make this the draft');
    }
  },

  async lint() {
    const specs = await localSpecs();
    if (!specs.length) die(`no spec files in ./${SPEC_DIR}`);
    let warnings = 0;
    for (const { file, spec } of specs) {
      const found = lint(spec);
      warnings += found.length;
      out(`${file}: ${found.length === 0 ? 'ok' : `${found.length} warning(s)`}`);
      for (const w of found) out(`  [${w.code}] ${w.node ? `${w.node}: ` : ''}${w.message}`);
    }
    process.exit(warnings > 0 && args.flags.strict ? 1 : 0);
  },

  async classify() {
    const [pipeline, ...rest] = args.positional;
    if (!pipeline) die('usage: pigeonhole classify <pipeline> "<text>"');
    const text = rest.join(' ');
    const input = text.trim().startsWith('{') ? JSON.parse(text) : { body: text };

    const result = await call<any>(`/v1/classify/${pipeline}`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
    if (args.flags.json) {
      out(JSON.stringify(result, null, 2));
      return;
    }
    out(JSON.stringify(result.output, null, 2));
    out('');
    for (const [node, answer] of Object.entries<any>(result.nodes)) {
      if (answer.skipped) continue;
      const value = answer.choice ?? answer.p ?? answer.score ?? answer.value;
      const confidence = answer.confidence !== undefined ? ` (confidence ${answer.confidence.toFixed(2)})` : '';
      out(`  ${node}: ${value}${confidence}${answer.low_confidence ? '  ← below min_confidence' : ''}`);
    }
    out(`\n${result.latency_ms}ms · ${result.usage.decision_calls} call(s) · ${result.model}`);
  },

  async test() {
    const only = args.positional[0];
    const pipelines = only
      ? [{ id: only }]
      : (await call<{ pipelines: { id: string }[] }>('/v1/pipelines')).pipelines;

    let failed = 0;
    for (const { id } of pipelines) {
      const report = await call<any>(`/v1/pipelines/${id}/evals?wait=true`, {
        method: 'POST',
        body: JSON.stringify({}),
      }).catch((e) => ({ error: (e as Error).message }));

      if (report.error) {
        out(`${id}: skipped (${report.error})`);
        continue;
      }
      const pct = (report.accuracy * 100).toFixed(1);
      const ok = report.passed === report.cases;
      if (!ok) failed++;
      out(`${ok ? 'PASS' : 'FAIL'} ${id}: ${report.passed}/${report.cases} (${pct}%) on ${report.resolved_model}`);

      for (const failure of report.failures ?? []) {
        out(`  ✗ ${failure.name ?? ''}`);
        out(`    input:    ${JSON.stringify(failure.input).slice(0, 140)}`);
        out(`    expected: ${JSON.stringify(failure.expected)}`);
        out(`    actual:   ${JSON.stringify(failure.actual)}`);
      }
      for (const confusion of report.top_confusions ?? []) {
        out(`  confused ${confusion.node}: ${confusion.expected} → ${confusion.actual} (${confusion.count}×)`);
      }
    }
    // Non-zero exit is the point of this command in CI.
    process.exit(failed > 0 ? 1 : 0);
  },

  async diff() {
    const pipeline = args.positional[0];
    if (!pipeline) die('usage: pigeonhole diff <pipeline> --models typesafe/jev-1.13,jev-latest');

    const models = String(args.flags.models ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const versions = String(args.flags.versions ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    const body =
      models.length === 2
        ? { left: { model: models[0] }, right: { model: models[1] } }
        : versions.length === 2
          ? { left: { version: Number(versions[0]) }, right: { version: Number(versions[1]) } }
          : die('give --models a,b or --versions 1,2');

    const result = await call<any>(`/v1/pipelines/${pipeline}/compare`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    out(`${result.cases} test case(s)\n`);
    out(`  ${result.left.label.padEnd(22)} ${(result.left.accuracy * 100).toFixed(1)}%  (${result.left.passed}/${result.left.cases})  ${result.left.resolved_model}`);
    out(`  ${result.right.label.padEnd(22)} ${(result.right.accuracy * 100).toFixed(1)}%  (${result.right.passed}/${result.right.cases})  ${result.right.resolved_model}`);
    const delta = result.delta * 100;
    out(`\n  delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} points`);
    if (delta < -3) {
      out('  this is a regression beyond the default drift threshold');
      process.exit(1);
    }
  },

  async bench() {
    const models = String(args.flags.models ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!models.length) die('usage: pigeonhole bench [pipeline…] --models jev-latest,clef-flash,gpt-6-luna');
    const ids = args.positional.length
      ? args.positional
      : (await call<{ pipelines: { id: string }[] }>('/v1/pipelines')).pipelines.map((p) => p.id);
    const concurrency = Number(args.flags.concurrency ?? 1);

    const totals = new Map(models.map((m) => [m, { passed: 0, cases: 0, errored: 0, cost: 0, p50: [] as number[], p95: [] as number[] }]));
    const rows: any[] = [];
    for (const id of ids) {
      for (const model of models) {
        const r = await call<any>(`/v1/pipelines/${id}/bench`, { method: 'POST', body: JSON.stringify({ model, concurrency }) });
        rows.push(r);
        const t = totals.get(model)!;
        t.passed += r.passed;
        t.cases += r.cases;
        t.errored += r.errored;
        t.cost += r.cost_usd;
        if (r.latency_ms.p50 !== null) t.p50.push(r.latency_ms.p50);
        if (r.latency_ms.p95 !== null) t.p95.push(r.latency_ms.p95);
        if (!args.flags.json) out(`${id.padEnd(24)} ${model.padEnd(22)} ${String(r.passed).padStart(3)}/${r.cases}  p50 ${r.latency_ms.p50 ?? '-'}ms  p95 ${r.latency_ms.p95 ?? '-'}ms  $${r.cost_usd.toFixed(5)}  ${r.resolved_model}${r.errored ? `  (${r.errored} errored: ${r.errors[0]})` : ''}`);
      }
    }
    if (args.flags.json) {
      out(JSON.stringify(rows, null, 2));
      return;
    }
    // Per-pipeline medians, so a long suite does not outvote a short one.
    const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
    out('\nall pipelines');
    for (const [model, t] of totals) {
      const pct = t.cases ? ((t.passed / t.cases) * 100).toFixed(0) : '-';
      const perMillion = t.cases ? (t.cost / t.cases) * 1e6 : 0;
      out(`  ${model.padEnd(22)} ${t.passed}/${t.cases} (${pct}%)  median of p50 ${median(t.p50) ?? '-'}ms  of p95 ${median(t.p95) ?? '-'}ms  $${t.cost.toFixed(4)}, about $${perMillion.toFixed(0)} per million${t.errored ? `  ${t.errored} errored` : ''}`);
    }
  },

  async push() {
    const only = args.positional[0];
    const specs = (await localSpecs()).filter((s) => !only || s.spec.id === only);
    if (!specs.length) die(`no spec files in ./${SPEC_DIR}${only ? ` for "${only}"` : ''}`);

    for (const { file, spec } of specs) {
      const existing = await call<{ pipelines: { id: string }[] }>('/v1/pipelines');
      if (!existing.pipelines.some((p) => p.id === spec.id)) {
        await call('/v1/pipelines', {
          method: 'POST',
          body: JSON.stringify({ id: spec.id, description: spec.description ?? '' }),
        });
      }
      const published = await call<{ version: number }>(`/v1/pipelines/${spec.id}/versions`, {
        method: 'POST',
        body: JSON.stringify({ spec, notes: `pushed from ${file}` }),
      });
      out(`${spec.id} → v${published.version}`);
    }
  },

  async pull() {
    const only = args.positional[0];
    const { pipelines } = await call<{ pipelines: { id: string }[] }>('/v1/pipelines');
    for (const { id } of pipelines) {
      if (only && id !== only) continue;
      const detail = await call<any>(`/v1/pipelines/${id}`);
      const spec = detail.draft ?? detail.versions[0]?.spec;
      if (!spec) continue;
      out(`wrote ${await writeSpec(spec)}`);
    }
  },

  async check() {
    const report = await call<any>('/v1/check');
    const mark = { ok: '\u2713', warn: '!', fail: '\u2717' } as const;
    for (const c of report.checks) {
      out(`${mark[c.state as keyof typeof mark]} ${c.name.padEnd(11)} ${c.detail}`);
      if (c.fix) out(`  fix: ${c.fix}`);
    }
    process.exit(report.healthy ? 0 : 1);
  },

  async mcp() {
    const { serveStdio } = await import('../mcp/server.js');
    const { waitForDatabase } = await import('../db/pool.js');
    await waitForDatabase();
    await serveStdio();
  },
};

async function pollCompile(pipeline: string, compileId: string): Promise<any> {
  let lastMessage = '';
  for (;;) {
    const status = await call<any>(`/v1/pipelines/${pipeline}/compile/${compileId}`);
    const message = String(status.progress?.message ?? status.status);
    if (message !== lastMessage) {
      process.stdout.write(`  ${message}\n`);
      lastMessage = message;
    }
    if (['done', 'failed', 'cancelled'].includes(status.status)) return status;
    await new Promise((r) => setTimeout(r, 1200));
  }
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-') || 'pipeline';

const command = COMMANDS[args.command] ?? COMMANDS.help;
command().catch((e) => die((e as Error).message));
