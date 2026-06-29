import { generateText } from "ai";
import logger from "@/logging";
import {
  getProviderChatInteractionType,
  withKbObservability,
} from "./kb-interaction";
import { resolveRerankerConfig } from "./kb-llm-client";

// === Exports ===

interface ExpandedQuery {
  queryText: string;
  weight: number;
  type: "semantic" | "keyword";
}

async function expandQuery(params: {
  queryText: string;
  organizationId: string;
}): Promise<ExpandedQuery[]> {
  const { queryText, organizationId } = params;

  const rerankerConfig = await resolveRerankerConfig(organizationId);
  if (!rerankerConfig) {
    logger.debug(
      { organizationId },
      "[QueryExpansion] No reranker config available, skipping expansion",
    );
    return [{ queryText, weight: 1.0, type: "semantic" }];
  }

  const [semanticResult, keywordResult] = await Promise.allSettled([
    semanticRephrase({ queryText, rerankerConfig }),
    keywordExpansion({ queryText, rerankerConfig }),
  ]);

  const queries: ExpandedQuery[] = [
    { queryText, weight: ORIGINAL_QUERY_WEIGHT, type: "semantic" },
  ];

  if (semanticResult.status === "fulfilled" && semanticResult.value) {
    logger.info(
      { type: "semantic", queryText: semanticResult.value },
      "[QueryExpansion] Generated semantic rephrase",
    );
    queries.push({
      queryText: semanticResult.value,
      weight: LLM_SEMANTIC_QUERY_WEIGHT,
      type: "semantic",
    });
  } else if (semanticResult.status === "rejected") {
    logger.warn(
      { error: semanticResult.reason },
      "[QueryExpansion] Semantic rephrase failed",
    );
  }

  if (keywordResult.status === "fulfilled" && keywordResult.value.length > 0) {
    for (const kw of keywordResult.value) {
      logger.info(
        { type: "keyword", queryText: kw },
        "[QueryExpansion] Generated keyword query",
      );
      queries.push({
        queryText: kw,
        weight: LLM_KEYWORD_QUERY_WEIGHT,
        type: "keyword",
      });
    }
  } else if (keywordResult.status === "rejected") {
    logger.warn(
      { error: keywordResult.reason },
      "[QueryExpansion] Keyword expansion failed",
    );
  }

  const deduped = deduplicateQueries(queries);

  logger.info(
    {
      originalQuery: queryText,
      expandedCount: deduped.length,
      queries: deduped.map((q) => ({
        text: q.queryText,
        weight: q.weight,
        type: q.type,
      })),
    },
    "[QueryExpansion] Expanded queries",
  );

  return deduped;
}

export { expandQuery };

// ===== Internal constants =====

const LLM_SEMANTIC_QUERY_WEIGHT = 1.3;
const LLM_KEYWORD_QUERY_WEIGHT = 1.0;
const ORIGINAL_QUERY_WEIGHT = 0.5;
const MAX_KEYWORD_QUERIES = 3;

/** Full-text weight for keyword queries in inner hybrid RRF */
export const KEYWORD_QUERY_HYBRID_ALPHA_WEIGHT = 4.0;

// ===== Internal helpers =====

interface RerankerConfig {
  // biome-ignore lint/suspicious/noExplicitAny: LLM model type from Vercel AI SDK
  llmModel: any;
  modelName: string;
  provider: string;
}

function deduplicateQueries(queries: ExpandedQuery[]): ExpandedQuery[] {
  const seen = new Map<string, ExpandedQuery>();
  for (const q of queries) {
    const key = q.queryText.toLowerCase().trim();
    const existing = seen.get(key);
    if (existing) {
      existing.weight += q.weight;
    } else {
      seen.set(key, { ...q });
    }
  }
  return [...seen.values()];
}

async function semanticRephrase(params: {
  queryText: string;
  rerankerConfig: RerankerConfig;
}): Promise<string | null> {
  const { queryText, rerankerConfig } = params;
  const currentDate = new Date().toISOString().split("T")[0];

  const result = await withKbObservability({
    operationName: "chat",
    provider: rerankerConfig.provider as Parameters<
      typeof withKbObservability
    >[0]["provider"],
    model: rerankerConfig.modelName,
    source: "knowledge:query-expansion",
    type: getProviderChatInteractionType(
      rerankerConfig.provider as Parameters<
        typeof getProviderChatInteractionType
      >[0],
    ),
    callback: () =>
      generateText({
        model: rerankerConfig.llmModel,
        system: SEMANTIC_QUERY_REPHRASE_SYSTEM_PROMPT.replace(
          "{current_date}",
          currentDate,
        ),
        prompt: SEMANTIC_QUERY_REPHRASE_USER_PROMPT.replace(
          "{user_query}",
          queryText,
        ),
      }),
    buildInteraction: (res) =>
      buildQueryExpansionInteraction(rerankerConfig, queryText, res),
  });

  const text = result.text?.trim();
  return text || null;
}

async function keywordExpansion(params: {
  queryText: string;
  rerankerConfig: RerankerConfig;
}): Promise<string[]> {
  const { queryText, rerankerConfig } = params;
  const currentDate = new Date().toISOString().split("T")[0];

  const result = await withKbObservability({
    operationName: "chat",
    provider: rerankerConfig.provider as Parameters<
      typeof withKbObservability
    >[0]["provider"],
    model: rerankerConfig.modelName,
    source: "knowledge:query-expansion",
    type: getProviderChatInteractionType(
      rerankerConfig.provider as Parameters<
        typeof getProviderChatInteractionType
      >[0],
    ),
    callback: () =>
      generateText({
        model: rerankerConfig.llmModel,
        system: KEYWORD_REPHRASE_SYSTEM_PROMPT.replace(
          "{current_date}",
          currentDate,
        ),
        prompt: KEYWORD_REPHRASE_USER_PROMPT.replace("{user_query}", queryText),
      }),
    buildInteraction: (res) =>
      buildQueryExpansionInteraction(rerankerConfig, queryText, res),
  });

  const text = result.text?.trim();
  if (!text) return [];

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_KEYWORD_QUERIES);
}

function buildQueryExpansionInteraction(
  config: { modelName: string; provider: string },
  prompt: string,
  // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK result type is complex
  result: any,
) {
  const usage = result.usage as
    | { promptTokens?: number; completionTokens?: number }
    | undefined;

  return {
    request: {
      model: config.modelName,
      messages: [{ role: "user" as const, content: prompt }],
    },
    response: {
      id: `query-expansion-${crypto.randomUUID()}`,
      object: "chat.completion" as const,
      created: Math.floor(Date.now() / 1000),
      model: config.modelName,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: result.text ?? "",
            refusal: null,
          },
          finish_reason: "stop" as const,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: usage?.promptTokens ?? 0,
        completion_tokens: usage?.completionTokens ?? 0,
        total_tokens:
          (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
      },
    },
    model: config.modelName,
    inputTokens: usage?.promptTokens ?? 0,
    outputTokens: usage?.completionTokens ?? 0,
  };
}

// ===== Prompts =====

const SEMANTIC_QUERY_REPHRASE_SYSTEM_PROMPT = `You convert a user's message into a single standalone search query optimized for semantic (embedding-based) retrieval. The output must be natural language that preserves the user's intent. Keep it as close to the original phrasing as possible — only modify when doing so clearly improves retrieval.

The current date is {current_date}.`;

const SEMANTIC_QUERY_REPHRASE_USER_PROMPT = `Rewrite the query below into a single self-contained search query. Most of the time the original wording is already good enough — return it as-is unless a change clearly helps retrieval.

When to modify:
1. Strip conversational framing that adds no search value:
"Could you pull up the runbook for the payment gateway?" -> "runbook for the payment gateway"
"Tell me everything we have about the Q4 forecast" -> "Q4 forecast"

2. Preserve identifiers, codes, and domain-specific terms exactly as written — never paraphrase them:
"What happened with INC40298173?" -> keep "INC40298173" verbatim

CRITICAL: Output ONLY the final query. No explanations, labels, or extra text.

User query:
{user_query}`;

const KEYWORD_REPHRASE_SYSTEM_PROMPT = `You generate keyword queries for a BM25 full-text search engine. Each query should be a short set of tokens designed to match document text. Output pure keywords — no filler words or natural language sentences.

The current date is {current_date}.`;

const KEYWORD_REPHRASE_USER_PROMPT = `Produce up to 3 keyword queries (one per line) to help a full-text search engine find documents relevant to the query below. Each query should use different terms to maximize recall.

Rules:
- Keywords only — no sentences, no filler words
- Keep each query as short as possible while capturing the intent
- Never paraphrase identifiers, ticket numbers, error codes, or domain-specific jargon — use them verbatim
- Vary the terms across queries; do not repeat the same keywords
- When the query contains a date or time period, expand it into the specific dates it covers. For example, for "september 2025" produce queries like "2025-09", "Sep 2025", "September 2025", "09/2025"

CRITICAL: Output ONLY the keyword queries, one per line. No numbering, bullets, or commentary.

User query:
{user_query}`;
