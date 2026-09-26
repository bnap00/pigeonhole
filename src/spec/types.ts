/** The pipeline spec: what a pipeline YAML file contains. */

export type NodeType = 'choice' | 'score' | 'noul' | 'rule';

/** Passed straight through to the decision model, so anything it accepts is valid here. */
export type Criterion =
  | null
  | string
  | string[]
  | { what?: string; not_for?: string; examples?: string[]; [k: string]: unknown };

export type LowConfidenceAction = 'human_review' | 'error' | `default:${string}`;

export interface BaseNode {
  type: NodeType;
  /** Gate on a prior answer. Speculative by default: it decides use, not execution. */
  when?: string;
  /** Opt out of speculative evaluation, for expensive option lists. */
  lazy?: boolean;
  description?: string;
}

export interface ChoiceNode extends BaseNode {
  type: 'choice';
  instructions: string;
  criteria: Record<string, Criterion>;
  min_confidence?: number;
  on_low_confidence?: LowConfidenceAction;
  /** Return every other option above this probability, for multi-team routing. */
  also_above?: number;
}

export interface ScoreNode extends BaseNode {
  type: 'score';
  instructions: string;
  scale: { min: number; max: number; labels?: Record<string, string> };
  min_confidence?: number;
  on_low_confidence?: LowConfidenceAction;
}

export interface NoulNode extends BaseNode {
  type: 'noul';
  instructions: string;
  min_confidence?: number;
  on_low_confidence?: LowConfidenceAction;
}

export interface RuleNode extends BaseNode {
  type: 'rule';
  /** Evaluated locally in the sandboxed expression language. No model call. */
  expr: string;
}

export type SpecNode = ChoiceNode | ScoreNode | NoulNode | RuleNode;

export type OutputMapping = string | { const: unknown };

export interface TestCase {
  name?: string;
  input: Record<string, unknown> | string;
  expect: Record<string, unknown>;
}

/** Runtime settings: answer cache and logging. Every key has a safe default. */
export interface ComposeBlock {
  cache?: { mode?: 'off' | 'memory'; ttl?: number };
  logging?: {
    telemetry?: 'postgres' | 'none';
    retain?: 'all' | 'sampled' | 'low_confidence' | 'none';
    sample_rate?: number;
    retention_days?: number;
    /** Input logging mode, from the core spec's privacy settings. */
    input?: 'full' | 'hash_only' | 'off';
    redact_pii?: boolean;
  };
}

export interface PipelineSpec {
  pigeonhole: 1;
  id: string;
  version?: number;
  description?: string;
  input?: Record<string, unknown>;
  model?: { runtime?: string; compiler?: string };
  nodes: Record<string, SpecNode>;
  output: Record<string, OutputMapping>;
  tests?: TestCase[];
  compose?: ComposeBlock;
}

export const isModelNode = (n: SpecNode): n is ChoiceNode | ScoreNode | NoulNode => n.type !== 'rule';

export interface LintWarning {
  node?: string;
  code: string;
  message: string;
}
