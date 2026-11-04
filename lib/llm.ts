import { AsyncLocalStorage } from "node:async_hooks";

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { estimateModelCost } from "./pricing";
import { parseJsonObject, readResponseText } from "./text";
import type { Usage } from "./types";

// Per grading job, including JSON retries that never produce a usable grade.
// The boundary stops new calls; requests already in flight can exceed it.
export type JudgeRequestUsage = {
  group?: string;
  model: string;
  usage: Usage;
  costUsd: number;
  reportedCostUsd: number | null;
  estimatedCostUsd: number | null;
  cacheRequested: boolean;
  cacheUsageReported: boolean;
};
export type JudgeSpend = {
  limitUsd: number;
  spentUsd: number;
  calls: number;
  requests?: JudgeRequestUsage[];
  onRecord?: () => Promise<void>;
};
const judgeSpend = new AsyncLocalStorage<{
  spend: JudgeSpend;
  group: string | undefined;
}>();

export function withJudgeSpend<T>(
  spend: JudgeSpend,
  run: () => Promise<T>,
  group?: string
) {
  return judgeSpend.run({ spend, group }, run);
}

async function recordJudgeRequest(request: JudgeRequestUsage) {
  const context = judgeSpend.getStore();
  if (!context) return;
  const { spend, group } = context;
  spend.spentUsd += request.costUsd;
  spend.requests?.push({
    ...request,
    ...(group === undefined ? {} : { group }),
  });
  await spend.onRecord?.();
}

// Task models and non-OpenAI graders use the gateway. OpenAI grading uses
// native Responses: the gateway currently discards explicit prefix markers.
export const GATEWAY_URL = "https://ai-gateway.vercel.sh";

// Gateway list price for provider web search (openai and anthropic entries in
// /v1/models: "web_search": "10" per 1,000 calls). Exa, used by the baseline,
// is billed at roughly the same order; we apply the same rate to it.
export const WEB_SEARCH_USD = 0.01;

export function gatewayKey() {
  const key = process.env.AI_GATEWAY_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "AI_GATEWAY_API_KEY is not set. Export it or pass bun --env-file=<file>."
    );
  }
  return key;
}

function openAIGradingKey() {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key)
    throw new Error(
      "OPENAI_API_KEY is required for native cached OpenAI grading."
    );
  return key;
}

export function requireJudgeCredentials(models: string[]) {
  if (models.some((model) => model.startsWith("openai/"))) openAIGradingKey();
  if (models.some((model) => !model.startsWith("openai/"))) gatewayKey();
}

let anthropic: Anthropic | null = null;
export function anthropicClient() {
  anthropic ??= new Anthropic({
    apiKey: gatewayKey(),
    baseURL: GATEWAY_URL,
    maxRetries: 4,
    timeout: 20 * 60 * 1000,
  });
  return anthropic;
}

export async function benchPostJson<T>(
  pathname: string,
  body: unknown,
  schema: z.ZodType<T>,
  connection?: { baseUrl: string; apiKey: string }
) {
  const transport = connection ?? {
    baseUrl: GATEWAY_URL,
    apiKey: gatewayKey(),
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${transport.baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${transport.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20 * 60 * 1000),
      });
      text = await readResponseText(response);
    } catch (error) {
      // A dropped connection or network timeout once scored judge lines 0;
      // retry it like a 5xx.
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      continue;
    }
    if (response.ok) return schema.parse(JSON.parse(text));
    lastError = new Error(
      `${pathname} ${response.status}: ${text.slice(0, 500)}`
    );
    if (response.status !== 429 && response.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
  }
  throw lastError;
}

// The gateway reports list-price ("market") cost next to what it billed. Use
// market cost: billed cost is 0 when the request went out on our own provider
// key (BYOK), which would make those systems look free.
type GatewayMeta = { gateway?: { cost?: string; marketCost?: string } };
export function gatewayReportedCost(body: unknown): number | null {
  const b = body as {
    provider_metadata?: GatewayMeta;
    usage?: { market_cost?: number };
    choices?: { message?: { provider_metadata?: GatewayMeta } }[];
  };
  const message = b?.choices?.[0]?.message?.provider_metadata?.gateway;
  const candidates = [
    b?.usage?.market_cost,
    b?.provider_metadata?.gateway?.marketCost,
    message?.marketCost,
    b?.provider_metadata?.gateway?.cost,
    message?.cost,
  ];
  for (const value of candidates) {
    const parsed = Number(value);
    if (value != null && Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// List-price estimate from the pricing table. Token counts here are
// totals (cache reads and writes included), which is what the table expects.
export function estimateUsd(model: string, usage: Usage) {
  const estimate = estimateModelCost(model, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  });
  if (!estimate.pricing) return null;
  return estimate.totalUsd + usage.webSearches * WEB_SEARCH_USD;
}

export type JsonCall<T> = { value: T; costUsd: number };

// Loose: gatewayReportedCost reads cost fields this schema does not name.
const ChatCompletionSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({ content: z.string().nullish() }).optional(),
      })
    )
    .optional(),
  usage: z
    .looseObject({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      prompt_tokens_details: z
        .looseObject({ cached_tokens: z.number().optional() })
        .optional(),
    })
    .optional(),
});

const GraderResponseSchema = z.looseObject({
  output: z.array(
    z.looseObject({
      type: z.string(),
      content: z
        .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
        .optional(),
    })
  ),
  usage: z.looseObject({
    input_tokens: z.number(),
    output_tokens: z.number(),
    input_tokens_details: z
      .looseObject({
        cached_tokens: z.number().optional(),
        cache_write_tokens: z.number().optional(),
      })
      .optional(),
  }),
});

// GPT-6 supports explicit cache breakpoints through Responses. Keep the
// reusable evidence in its own block; the criterion changes after it.
async function callOpenAIText(params: {
  model: string;
  system: string;
  prompt: string;
  cachePrefix?: string;
}) {
  const apiKey = openAIGradingKey();
  if (
    estimateUsd(params.model, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
    }) == null
  )
    throw new Error(
      `No grading cost estimate for ${params.model}; add verified prices before making paid calls.`
    );
  const body = await benchPostJson(
    "/v1/responses",
    {
      model: params.model.replace(/^openai\//, ""),
      input: [
        { role: "developer", content: params.system },
        ...(params.cachePrefix
          ? [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: params.cachePrefix,
                    prompt_cache_breakpoint: { mode: "explicit" },
                  },
                ],
              },
            ]
          : []),
        { role: "user", content: params.prompt },
      ],
      ...(params.cachePrefix
        ? { prompt_cache_options: { mode: "explicit" } }
        : {}),
      reasoning: { effort: "medium" },
      text: { format: { type: "json_object" } },
    },
    GraderResponseSchema,
    { baseUrl: "https://api.openai.com", apiKey }
  );
  const usage: Usage = {
    inputTokens: body.usage.input_tokens,
    outputTokens: body.usage.output_tokens,
    cacheReadTokens: body.usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: body.usage.input_tokens_details?.cache_write_tokens ?? 0,
    webSearches: 0,
  };
  const reportedCostUsd = gatewayReportedCost(body);
  const estimatedCostUsd = estimateUsd(params.model, usage);
  return {
    text: body.output
      .flatMap((part) => part.content ?? [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text ?? "")
      .join(""),
    usage,
    cacheUsageReported: body.usage.input_tokens_details?.cached_tokens != null,
    reportedCostUsd,
    estimatedCostUsd,
    costUsd:
      reportedCostUsd != null && reportedCostUsd > 0
        ? reportedCostUsd
        : (estimatedCostUsd ?? reportedCostUsd ?? 0),
  };
}

// Non-Anthropic judges go through the gateway's chat completions endpoint.
async function callChatText(params: {
  model: string;
  system: string;
  prompt: string;
  cachePrefix?: string;
}) {
  const body = await benchPostJson(
    "/v1/chat/completions",
    {
      model: params.model,
      messages: [
        { role: "system", content: params.system },
        ...(params.cachePrefix
          ? [{ role: "user", content: params.cachePrefix }]
          : []),
        { role: "user", content: params.prompt },
      ],
    },
    ChatCompletionSchema
  );
  const usage: Usage = {
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
    cacheReadTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    webSearches: 0,
  };
  const reportedCostUsd = gatewayReportedCost(body);
  const estimatedCostUsd = estimateUsd(params.model, usage);
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    usage,
    cacheUsageReported:
      body.usage?.prompt_tokens_details?.cached_tokens != null,
    reportedCostUsd,
    estimatedCostUsd,
    // A positive market cost includes provider cache pricing that the token
    // fields may omit. Estimate only when cost is absent or zero (e.g. BYOK).
    costUsd:
      reportedCostUsd != null && reportedCostUsd > 0
        ? reportedCostUsd
        : (estimatedCostUsd ?? reportedCostUsd ?? 0),
  };
}

// One grading call (judge or extractor). Returns parsed JSON and its cost.
export async function callJson<T>(params: {
  model: string;
  system: string;
  prompt: string;
  // Sent before `prompt` and marked cacheable, so calls that share it (every
  // judge line for one answer) read it from the provider cache.
  cachePrefix?: string;
  // Output that fails it is retried like unparseable JSON.
  schema: z.ZodType<T>;
}): Promise<JsonCall<T>> {
  let costUsd = 0;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const spend = judgeSpend.getStore()?.spend;
    if (spend && spend.spentUsd >= spend.limitUsd)
      throw new Error(
        `Judge budget reached: $${spend.spentUsd.toFixed(3)}; no new call launched.`
      );
    if (spend) spend.calls += 1;
    if (!params.model.startsWith("anthropic/")) {
      const result = params.model.startsWith("openai/")
        ? await callOpenAIText(params)
        : await callChatText(params);
      costUsd += result.costUsd;
      await recordJudgeRequest({
        model: params.model,
        usage: result.usage,
        costUsd: result.costUsd,
        reportedCostUsd: result.reportedCostUsd,
        estimatedCostUsd: result.estimatedCostUsd,
        cacheRequested: Boolean(params.cachePrefix),
        cacheUsageReported: result.cacheUsageReported,
      });
      try {
        return {
          value: parseJsonObject(result.text, params.schema),
          costUsd,
        };
      } catch (error) {
        lastError = error;
        continue;
      }
    }
    const message = await anthropicClient().messages.create({
      model: params.model,
      max_tokens: 8000,
      system: params.system,
      messages: [
        {
          role: "user",
          content: [
            ...(params.cachePrefix
              ? [
                  {
                    type: "text" as const,
                    text: params.cachePrefix,
                    cache_control: { type: "ephemeral" as const },
                  },
                ]
              : []),
            { type: "text" as const, text: params.prompt },
          ],
        },
      ],
      output_config: { effort: "medium" },
    });
    const usage = message.usage;
    const tokens: Usage = {
      inputTokens:
        usage.input_tokens +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      webSearches: 0,
    };
    const reportedCostUsd = gatewayReportedCost(message);
    const estimatedCostUsd = estimateUsd(params.model, tokens);
    const attemptCost =
      reportedCostUsd != null && reportedCostUsd > 0
        ? reportedCostUsd
        : (estimatedCostUsd ?? reportedCostUsd ?? 0);
    costUsd += attemptCost;
    await recordJudgeRequest({
      model: params.model,
      usage: tokens,
      costUsd: attemptCost,
      reportedCostUsd,
      estimatedCostUsd,
      cacheRequested: Boolean(params.cachePrefix),
      cacheUsageReported: usage.cache_read_input_tokens != null,
    });
    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    try {
      return { value: parseJsonObject(text, params.schema), costUsd };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
