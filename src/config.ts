/**
 * Every setting the app has. The few that vary per install come from the
 * environment.
 *
 * Only OPENROUTER_API_KEY, PH_ADMIN_TOKEN and DATABASE_URL matter for a normal
 * install; everything else has a working default.
 */
import { readFileSync } from 'node:fs';
import { isDecisionModel, notADecisionModel } from './provider/models.js';

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const config = {
  version: pkg.version,
  port: int('PORT', 8080),
  host: str('HOST', '0.0.0.0'),
  /** The externally reachable base URL, used in generated OpenAPI documents. */
  publicUrl: str('PH_PUBLIC_URL', 'http://localhost:8080'),
  logLevel: str('LOG_LEVEL', 'info'),

  databaseUrl: str('DATABASE_URL', 'postgres://pigeonhole:pigeonhole@localhost:5432/pigeonhole'),

  /**
   * OpenRouter answers everything today: a decision model (Jev) through the
   * Decisions API for classifications, and a reasoning model through chat
   * completions for the compiler.
   */
  openrouterApiKey: str('OPENROUTER_API_KEY', ''),
  defaultRuntimeModel: str('PH_RUNTIME_MODEL', 'jev-latest'),
  defaultCompilerModel: str('PH_COMPILER_MODEL', 'anthropic/claude-sonnet-5'),

  /** Control-plane bearer token. Required: the app refuses to start without it. */
  adminToken: str('PH_ADMIN_TOKEN', ''),

  /** Seed the demo pipeline on first boot. Tests turn it off. */
  seedTemplates: bool('PH_SEED_TEMPLATES', true),

  // Fixed limits. They are constants rather than settings so there is less to
  // configure; change them here if a deployment needs to.
  maxBodyBytes: 64 * 1024,
  /** The decision model's context ceiling, in characters of serialized state (conservative 4:1). */
  maxInputChars: 120_000,
  rateLimitPerMinute: 600,
  /** Monthly compile spend in USD, checked before a compile runs. */
  compileBudgetUsd: 25,
  /** An accuracy drop this large between nightly evals is drift: 3 points. */
  driftThreshold: 0.03,
  /** How long retained runs and run telemetry are kept. */
  retentionDays: 30,
};

if (!isDecisionModel(config.defaultRuntimeModel)) {
  throw new Error(`PH_RUNTIME_MODEL: ${notADecisionModel(config.defaultRuntimeModel)}`);
}

export type Config = typeof config;
