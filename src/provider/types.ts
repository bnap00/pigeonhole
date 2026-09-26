/** The provider-facing shape of a decision call and a compiler chat call. */

export interface DecisionQuestion {
  type: 'choice' | 'score' | 'noul';
  instructions: string;
  criteria?: Record<string, unknown>;
  scale?: { min: number; max: number; labels?: Record<string, string> };
}

export interface DecisionRequest {
  model: string;
  /** Validated pipeline input: a string, or a JSON object. Text only. */
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  timeoutMs?: number;
}

export interface DecisionAnswer {
  /** choice nodes */
  choice?: string;
  probabilities?: Record<string, number>;
  /** score nodes */
  score?: number;
  /** noul nodes */
  p?: number;
  confidence?: number;
}

export interface DecisionUsage {
  input_tokens: number;
  output_tokens?: number;
  /** Reported by OpenRouter when it knows the price. */
  cost_usd?: number;
}

export interface DecisionResponse {
  answers: Record<string, DecisionAnswer>;
  /** The resolved model version, e.g. typesafe/jev-1.13-20260917. Drift detection depends on it. */
  model: string;
  usage: DecisionUsage;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** When set, the adapter asks for JSON matching this schema and parses it. */
  schema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatResponse {
  text: string;
  json?: unknown;
  model: string;
  usage: { input_tokens: number; output_tokens: number; cost_usd?: number };
}

export interface Provider {
  /** Runs one decision call with N questions. */
  decide(req: DecisionRequest): Promise<DecisionResponse>;
  /** Used by the compiler; not on the hot path. */
  chat(req: ChatRequest): Promise<ChatResponse>;
}
