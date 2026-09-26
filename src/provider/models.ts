/**
 * Which models may answer a classification: decision models, never a chat
 * model — and which provider serves each one.
 *
 * A chat model asked for probabilities returns numbers shaped like a decision
 * model's with none of their meaning. Every threshold, review rule and drift
 * alert here assumes the probabilities are calibrated, so a chat model on the
 * classify path would make all of them route on noise. The guarantee is
 * enforced here, before any request is sent.
 *
 * To add a decision model, add its family below with the provider that serves
 * it. A family served somewhere other than OpenRouter (Laya on a local server,
 * say) also needs a provider module, registered in `provider/index.ts`.
 */

export type DecisionProviderName = 'openrouter';

interface DecisionFamily {
  name: string;
  provider: DecisionProviderName;
  /** Every model id in the family, including the resolved ids a response reports. */
  pattern: RegExp;
  examples: string;
}

const FAMILIES: DecisionFamily[] = [
  {
    // jev, jev-latest, jev-1.13.0, typesafe/jev-1.13, typesafe/jev-1.13-20260917
    name: 'Jev',
    provider: 'openrouter',
    pattern: /^(?:[a-z0-9-]+\/)?jev(?:-[a-z0-9.]+)*$/i,
    examples: 'jev-latest, or a pinned version such as typesafe/jev-1.13',
  },
];

/** The provider that serves this model, or null if it is not a decision model. */
export function decisionProviderFor(model: string): DecisionProviderName | null {
  const id = model.trim();
  return FAMILIES.find((f) => f.pattern.test(id))?.provider ?? null;
}

export function isDecisionModel(model: string): boolean {
  return decisionProviderFor(model) !== null;
}

export function notADecisionModel(model: string): string {
  const accepted = FAMILIES.map((f) => `${f.name} (${f.examples})`).join('; ');
  return `"${model}" is not a decision model. Classifications are answered only by decision models — ${accepted} — never by a chat model.`;
}
