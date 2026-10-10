// List prices in USD per token, as of 2026-09-22. Check them against
// the providers' current rates before quoting costs. A model missing here
// reports its cost as n/a; add a row to price it.

export type ModelPricing = {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  cacheReadUsdPerToken?: number;
  cacheWriteUsdPerToken?: number;
};

const PRICES: Record<string, ModelPricing> = {
  "anthropic/claude-opus-5": {
    "inputUsdPerToken": 0.000005,
    "outputUsdPerToken": 0.000025,
    "cacheReadUsdPerToken": 5e-7,
    "cacheWriteUsdPerToken": 0.00000625
  },
  "anthropic/claude-sonnet-5": {
    "inputUsdPerToken": 0.000002,
    "outputUsdPerToken": 0.00001,
    "cacheReadUsdPerToken": 2e-7,
    "cacheWriteUsdPerToken": 0.0000025
  },
  "openai/gpt-6-astra": {
    "inputUsdPerToken": 0.00001,
    "outputUsdPerToken": 0.00005,
    "cacheReadUsdPerToken": 0.000001,
    "cacheWriteUsdPerToken": 0.0000125
  },
  "openai/gpt-5.6-sol": {
    "inputUsdPerToken": 0.000005,
    "outputUsdPerToken": 0.00003,
    "cacheReadUsdPerToken": 5e-7,
    "cacheWriteUsdPerToken": 0.00000625
  },
  "google/gemini-3.1-pro-preview": {
    "inputUsdPerToken": 0.000002,
    "outputUsdPerToken": 0.000012,
    "cacheReadUsdPerToken": 2e-7,
    "cacheWriteUsdPerToken": 3.75e-7
  },
  "deepseek/deepseek-v4-pro": {
    "inputUsdPerToken": 7.134e-7,
    "outputUsdPerToken": 0.0000014268,
    "cacheReadUsdPerToken": 5.945e-8
  }
};

const ALIASES: Record<string, string> = {
  "claude-opus-5": "anthropic/claude-opus-5",
  "claude-5-opus": "anthropic/claude-opus-5",
  "anthropic/claude-5-opus": "anthropic/claude-opus-5",
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
  "claude-5-sonnet": "anthropic/claude-sonnet-5",
  "anthropic/claude-5-sonnet": "anthropic/claude-sonnet-5",
  "gpt-6-astra": "openai/gpt-6-astra",
  "gpt-5.6": "openai/gpt-5.6-sol",
  "gpt-5-6": "openai/gpt-5.6-sol",
  "gpt-5.6-sol": "openai/gpt-5.6-sol",
  "gpt-5-6-sol": "openai/gpt-5.6-sol",
  "openai/gpt-5.6": "openai/gpt-5.6-sol",
  "gemini-3.1-pro-preview": "google/gemini-3.1-pro-preview",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4": "deepseek/deepseek-v4-pro"
};

function resolve(modelId: string) {
  const id = modelId.toLowerCase().trim();
  if (PRICES[id]) return PRICES[id];
  const aliased = ALIASES[id] ?? ALIASES[id.split("/").slice(1).join("/")];
  return aliased ? (PRICES[aliased] ?? null) : null;
}

export type CostUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

// Cache reads and writes are a subset of inputTokens and bill at their own rate.
export function estimateModelCost(
  modelId: string | null | undefined,
  usage: CostUsage
) {
  const pricing = modelId ? resolve(modelId) : null;
  if (!pricing) return { totalUsd: 0, pricing: null };
  const input = usage.inputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, input - cacheRead - cacheWrite);
  const totalUsd =
    uncached * pricing.inputUsdPerToken +
    (usage.outputTokens ?? 0) * pricing.outputUsdPerToken +
    cacheRead * (pricing.cacheReadUsdPerToken ?? pricing.inputUsdPerToken) +
    cacheWrite * (pricing.cacheWriteUsdPerToken ?? pricing.inputUsdPerToken);
  return { totalUsd, pricing };
}
