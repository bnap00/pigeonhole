/**
 * Template gallery and first-boot seeding.
 *
 * The first screen a new operator sees should be a working product, not an
 * empty state. On first boot the stack loads the template gallery, publishes
 * the demo pipeline as version 1, and stores its test cases, so `docker
 * compose up` ends with something that classifies.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpecYaml } from './spec/parse.js';
import type { PipelineSpec } from './spec/types.js';
import * as repo from './db/repo.js';
import { invalidateSpec } from './cache/specs.js';
import { config } from './config.js';
import { log } from './log.js';

export interface Template {
  id: string;
  title: string;
  description: string;
  yaml: string;
  spec: PipelineSpec;
}

/** The pipeline seeded on first boot, so the UI opens on a real example. */
const DEMO = 'support-triage';

function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return process.env.PH_TEMPLATES_DIR ?? join(here, '..', 'templates');
}

let cached: Template[] | null = null;

export function templates(): Template[] {
  if (cached) return cached;
  const dir = templatesDir();
  const out: Template[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch (err) {
    log.warn('template gallery is not readable', { dir, error: (err as Error).message });
    cached = [];
    return cached;
  }
  for (const file of files) {
    const yaml = readFileSync(join(dir, file), 'utf8');
    try {
      const spec = parseSpecYaml(yaml);
      out.push({
        id: spec.id,
        title: titleCase(spec.id),
        description: (spec.description ?? '').trim(),
        yaml,
        spec,
      });
    } catch (err) {
      // A broken template should not stop the stack from booting.
      log.warn('template failed to parse and was skipped', { file, error: (err as Error).message });
    }
  }
  cached = out;
  return out;
}

const titleCase = (id: string) =>
  id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * Runs once, guarded by a row in `meta` so restarts and extra replicas do not
 * re-seed or clobber a pipeline the user has since edited.
 */
export async function seedIfEmpty(): Promise<{ seeded: boolean; pipeline?: string }> {
  if (!config.seedTemplates) return { seeded: false };

  const already = await repo.getMeta<string>('seed:completed');
  if (already) return { seeded: false };

  const demo = templates().find((t) => t.id === DEMO) ?? templates()[0];
  if (!demo) {
    log.warn('nothing to seed: the template gallery is empty');
    return { seeded: false };
  }

  const existing = await repo.listPipelines();
  // Anything the operator made themselves means this is not a fresh stack.
  if (existing.some((p) => p.id !== demo.spec.id)) {
    await repo.setMeta('seed:completed', new Date().toISOString());
    return { seeded: false };
  }

  // Each step below is idempotent, so a boot that died partway through seeding
  // finishes the job on the next start rather than leaving a pipeline with no
  // published version.
  if (!(await repo.getPipeline(demo.spec.id))) {
    await repo.createPipeline({
      id: demo.spec.id,
      description: demo.spec.description ?? '',
      draft_spec: demo.spec,
      owner: 'seed',
    });
  }
  const published = await repo.latestVersion(demo.spec.id);
  const version = published ?? (await repo.publishVersion(demo.spec.id, demo.spec, 'seed', 'seeded template'));

  if ((await repo.listTestCases(demo.spec.id)).length === 0) {
    for (const test of demo.spec.tests ?? []) {
      await repo.addTestCase(demo.spec.id, test, 'compiler');
    }
  }
  await invalidateSpec(demo.spec.id, version.version);
  await repo.setMeta('seed:completed', new Date().toISOString());

  log.info('seeded the demo pipeline', {
    pipeline: demo.spec.id,
    version: version.version,
    tests: demo.spec.tests?.length ?? 0,
  });
  return { seeded: true, pipeline: demo.spec.id };
}
