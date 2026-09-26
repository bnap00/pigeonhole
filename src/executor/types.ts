import type { DecisionUsage } from '../provider/types.js';
import type { LowConfidenceAction } from '../spec/types.js';

export interface NodeResult {
  type: 'choice' | 'score' | 'noul' | 'rule';
  choice?: string;
  probabilities?: Record<string, number>;
  score?: number;
  p?: number;
  confidence?: number;
  /** The node's primary answer, whatever its type. What `x.value` reads. */
  value?: unknown;
  /** True when min_confidence was not met. Readable as `x.low_confidence`. */
  low_confidence?: boolean;
  /** Secondary labels above `also_above`, for multi-team routing. */
  also?: string[];
  /** True when a `when` gate excluded this node from the output. */
  skipped?: boolean;
  /** Set when on_low_confidence changed the answer. */
  action?: LowConfidenceAction;
  error?: string;
}

export interface RunResult {
  run_id: string;
  pipeline: string;
  version: number;
  output: Record<string, unknown>;
  nodes: Record<string, NodeResult>;
  model: string;
  usage: DecisionUsage & { decision_calls: number };
  latency_ms: number;
  cached: boolean;
  needs_review: boolean;
}
