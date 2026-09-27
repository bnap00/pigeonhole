/**
 * The provider every caller uses. Classifications go to whichever provider
 * serves the requested decision model (see `models.ts`); the compiler's chat
 * calls always go to OpenRouter. Tests swap in a fake.
 */
import { createOpenRouterProvider } from './openrouter.js';
import { createLayaProvider } from './laya.js';
import { decisionProviderFor, notADecisionModel, type DecisionProviderName } from './models.js';
import { problem } from '../errors.js';
import type { Provider } from './types.js';

let current: Provider | null = null;

function createRouter(): Provider {
  const openrouter = createOpenRouterProvider();
  const decisionProviders: Record<DecisionProviderName, Provider['decide']> = {
    openrouter: openrouter.decide,
    laya: createLayaProvider(),
  };
  return {
    async decide(req) {
      const name = decisionProviderFor(req.model);
      if (!name) throw problem('input_invalid', notADecisionModel(req.model));
      return decisionProviders[name](req);
    },
    chat: openrouter.chat,
  };
}

export function provider(): Provider {
  current ??= createRouter();
  return current;
}

/** Test seam. Pass null to go back to the real providers. */
export function setProvider(next: Provider | null): void {
  current = next;
}

export type { Provider } from './types.js';
