import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { estimateModelCost } from "./pricing";
import { parseJsonObject, readResponseText } from "./text";
import type { Usage } from "./types";

// Every model call in this bench goes through the Vercel AI Gateway, so one
// key covers OpenAI, Anthropic and open-weight models and the gateway reports
// billed cost where it can.
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

export async function gatewayPost<T>(
  pathname: string,
  body: unknown,
  schema: z.ZodType<T>
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${GATEWAY_URL}${pathname}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gatewayKey()}`,
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

// Non-Anthropic judges go through the gateway's chat completions endpoint.
async function callChatText(params: {
  model: string;
  system: string;
  prompt: string;
}) {
  const body = await gatewayPost(
    "/v1/chat/completions",
    {
      model: params.model,
      messages: [
        { role: "system", content: params.system },
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
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    // A BYOK request reports $0, so never let the report undercut list price.
    costUsd: Math.max(
      gatewayReportedCost(body) ?? 0,
      estimateUsd(params.model, usage) ?? 0
    ),
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
    if (!params.model.startsWith("anthropic/")) {
      const result = await callChatText({
        ...params,
        prompt: params.cachePrefix
          ? `${params.cachePrefix}\n\n${params.prompt}`
          : params.prompt,
      });
      costUsd += result.costUsd;
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
    costUsd +=
      estimateUsd(params.model, {
        inputTokens:
          usage.input_tokens +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        webSearches: 0,
      }) ?? 0;
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
