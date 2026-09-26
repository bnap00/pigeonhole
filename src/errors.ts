/** RFC 9457 problem JSON. Every error the API returns goes through here. */

export type ProblemCode =
  | 'input_invalid'
  | 'spec_invalid'
  | 'pipeline_not_found'
  | 'version_not_found'
  | 'run_not_found'
  | 'low_confidence'
  | 'rate_limited'
  | 'unauthorized'
  | 'forbidden'
  | 'payload_too_large'
  | 'provider_error'
  | 'budget_exceeded'
  | 'not_ready'
  | 'conflict'
  | 'feature_unavailable'
  | 'internal_error';

const STATUS: Record<ProblemCode, number> = {
  input_invalid: 400,
  spec_invalid: 400,
  pipeline_not_found: 404,
  version_not_found: 404,
  run_not_found: 404,
  low_confidence: 422,
  rate_limited: 429,
  unauthorized: 401,
  forbidden: 403,
  payload_too_large: 413,
  provider_error: 502,
  budget_exceeded: 402,
  not_ready: 503,
  conflict: 409,
  feature_unavailable: 501,
  internal_error: 500,
};

export class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly detail: string;
  readonly extra: Record<string, unknown>;

  constructor(code: ProblemCode, detail: string, extra: Record<string, unknown> = {}) {
    super(detail);
    this.name = 'ProblemError';
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
    this.extra = extra;
  }

  toProblem(instance?: string) {
    return {
      type: `https://pigeonhole.dev/errors/${this.code}`,
      title: this.code.replace(/_/g, ' '),
      status: this.status,
      detail: this.detail,
      code: this.code,
      ...(instance ? { instance } : {}),
      ...this.extra,
    };
  }
}

export const problem = (code: ProblemCode, detail: string, extra?: Record<string, unknown>) =>
  new ProblemError(code, detail, extra);

