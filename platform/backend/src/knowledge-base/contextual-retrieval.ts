import type { SupportedProvider } from "@archestra/shared";
import { generateObject, generateText, type ModelMessage } from "ai";
import { z } from "zod";
import { isAnthropicNativeEndpoint } from "@/clients/anthropic-endpoint";
import logger from "@/logging";
import {
  getProviderChatInteractionType,
  withKbObservability,
} from "./kb-interaction";
import { resolveContextualRetrievalConfig } from "./kb-llm-client";

// ===== Exports =====

/**
 * Generate search-only context headers aligned with a document's chunks.
 *
 * The organization chooses between disabled, document-level, and per-chunk
 * context. Per-chunk generation is reserved for longer documents, batches
 * several passages into each call, and marks the stable document prefix for
 * prompt caching on providers that require an explicit breakpoint. Every
 * failure is best-effort: the affected chunks are indexed without a header.
 */
export async function buildContextualHeaders(params: {
  title: string;
  content: string;
  chunks: string[];
  organizationId: string;
  connectorId: string | null;
}): Promise<(string | null)[]> {
  const { title, content, chunks, organizationId, connectorId } = params;
  if (chunks.length === 0) return [];

  const emptyHeaders = () => chunks.map(() => null);
  if (!content.trim()) return emptyHeaders();

  let resolved: Awaited<ReturnType<typeof resolveContextualRetrievalConfig>>;
  try {
    resolved = await resolveContextualRetrievalConfig(organizationId);
  } catch (error) {
    logger.warn(
      {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[ContextualRetrieval] Configuration unresolvable, indexing without context",
    );
    return emptyHeaders();
  }

  if (resolved.mode === "disabled") return emptyHeaders();
  if (!resolved.reranker) {
    logger.debug(
      { organizationId },
      "[ContextualRetrieval] No reranking model configured, indexing without context",
    );
    return emptyHeaders();
  }
  if (resolved.reranker.kind !== "llm") {
    logger.debug(
      { organizationId },
      "[ContextualRetrieval] Reranking model is rerank-only, indexing without context",
    );
    return emptyHeaders();
  }

  if (
    resolved.mode === "document" ||
    chunks.length < MIN_CHUNKS_FOR_PER_CHUNK_CONTEXT
  ) {
    const header = await buildDocumentContext({
      title,
      content,
      connectorId,
      config: resolved.reranker,
    });
    return chunks.map(() => header);
  }

  return buildChunkContexts({
    title,
    content,
    chunks,
    connectorId,
    config: resolved.reranker,
  });
}

/**
 * Trim and wrap a raw model response into the header stored on each chunk.
 * Returns `null` for an empty response so callers treat "the model said
 * nothing" the same as "contextual retrieval is off".
 *
 * @public — pure formatting step, exercised directly in unit tests
 */
export function formatContext(rawText: string | undefined): string | null {
  const text = rawText?.trim();
  if (!text) return null;

  const capped =
    text.length > MAX_CONTEXT_CHARS
      ? `${text.slice(0, MAX_CONTEXT_CHARS).trimEnd()}…`
      : text;

  return `CONTEXT: ${capped}\n\n`;
}

// ===== Internal helpers =====

type LlmRerankerConfig = Extract<
  NonNullable<
    Awaited<ReturnType<typeof resolveContextualRetrievalConfig>>["reranker"]
  >,
  { kind: "llm" }
>;

async function buildDocumentContext(params: {
  title: string;
  content: string;
  connectorId: string | null;
  config: LlmRerankerConfig;
}): Promise<string | null> {
  const { title, content, connectorId, config } = params;
  const prompt = DOCUMENT_CONTEXT_USER_PROMPT.replace(
    "{document_title}",
    title,
  ).replace("{document_content}", truncateForPrompt(content));

  try {
    const result = await withKbObservability({
      operationName: "chat",
      provider: config.provider,
      model: config.modelName,
      source: "knowledge:contextual-retrieval",
      connectorId,
      type: getProviderChatInteractionType(config.provider),
      callback: () =>
        generateText({
          model: config.llmModel,
          system: DOCUMENT_CONTEXT_SYSTEM_PROMPT,
          prompt,
        }),
      buildInteraction: (result) =>
        buildContextualRetrievalInteraction({
          config,
          requestDescription: prompt,
          responseText: result.text,
          usage: result.usage,
        }),
    });

    return formatContext(result.text);
  } catch (error) {
    logger.warn(
      {
        connectorId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[ContextualRetrieval] Failed to generate document context, indexing without it",
    );
    return null;
  }
}

async function buildChunkContexts(params: {
  title: string;
  content: string;
  chunks: string[];
  connectorId: string | null;
  config: LlmRerankerConfig;
}): Promise<(string | null)[]> {
  const { title, content, chunks, connectorId, config } = params;
  const contexts: (string | null)[] = chunks.map(() => null);
  const sharedDocumentMessage = buildSharedDocumentMessage({
    title,
    content,
    config,
  });

  // Sequential on purpose: explicit provider caches must finish writing the
  // stable document prefix before the next batch can read it.
  for (
    let batchStart = 0;
    batchStart < chunks.length;
    batchStart += CHUNK_CONTEXT_BATCH_SIZE
  ) {
    const batch = chunks.slice(
      batchStart,
      batchStart + CHUNK_CONTEXT_BATCH_SIZE,
    );
    const batchPrompt = buildChunkBatchPrompt({
      chunks,
      batchStart,
      batchLength: batch.length,
    });

    try {
      const schema = z.object({
        contexts: z
          .array(z.string())
          .length(batch.length)
          .describe(
            "One short context passage per requested chunk, in the same order",
          ),
      });
      const result = await withKbObservability({
        operationName: "chat",
        provider: config.provider,
        model: config.modelName,
        source: "knowledge:contextual-retrieval",
        connectorId,
        type: getProviderChatInteractionType(config.provider),
        callback: () =>
          generateObject({
            model: config.llmModel,
            schema,
            system: CHUNK_CONTEXT_SYSTEM_PROMPT,
            messages: [
              sharedDocumentMessage,
              { role: "user", content: batchPrompt },
            ],
          }),
        buildInteraction: (result) =>
          buildContextualRetrievalInteraction({
            config,
            requestDescription: batchPrompt,
            responseText: JSON.stringify(result.object),
            usage: result.usage,
          }),
      });

      for (const [offset, context] of result.object.contexts.entries()) {
        contexts[batchStart + offset] = formatContext(context);
      }
    } catch (error) {
      logger.warn(
        {
          connectorId,
          batchStart,
          batchSize: batch.length,
          error: error instanceof Error ? error.message : String(error),
        },
        "[ContextualRetrieval] Failed to generate a chunk-context batch, indexing those chunks without context",
      );
    }
  }

  return contexts;
}

function buildSharedDocumentMessage(params: {
  title: string;
  content: string;
  config: LlmRerankerConfig;
}): ModelMessage {
  const message: ModelMessage = {
    role: "user",
    content: CHUNK_CONTEXT_DOCUMENT_PROMPT.replace(
      "{document_title}",
      params.title,
    ).replace("{document_content}", truncateForPrompt(params.content)),
  };
  const providerOptions = promptCacheProviderOptions(params.config);
  return providerOptions ? { ...message, providerOptions } : message;
}

function promptCacheProviderOptions(
  config: LlmRerankerConfig,
): ModelMessage["providerOptions"] | undefined {
  if (
    isAnthropicNativeEndpoint({
      provider: config.provider,
      model: config.modelName,
      baseUrl: config.baseUrl,
    })
  ) {
    return { anthropic: { cacheControl: { type: "ephemeral" } } };
  }

  // Bedrock rejects cache points for unsupported model families. Match the
  // same conservative set as the chat path so caching can never break ingest.
  if (
    config.provider === "bedrock" &&
    BEDROCK_PROMPT_CACHE_MODEL.test(config.modelName)
  ) {
    return { bedrock: { cachePoint: { type: "default" } } };
  }

  // OpenAI and Gemini cache matching prefixes automatically. Other providers
  // either do the same or do not expose a portable cache directive.
  return undefined;
}

function buildChunkBatchPrompt(params: {
  chunks: string[];
  batchStart: number;
  batchLength: number;
}): string {
  const targetEnd = params.batchStart + params.batchLength;
  const windowStart = Math.max(0, params.batchStart - SURROUNDING_CHUNK_RADIUS);
  const windowEnd = Math.min(
    params.chunks.length,
    targetEnd + SURROUNDING_CHUNK_RADIUS,
  );
  const passages = params.chunks
    .slice(windowStart, windowEnd)
    .map((chunk, offset) => {
      const index = windowStart + offset;
      const role =
        index >= params.batchStart && index < targetEnd
          ? "write context"
          : "surrounding context only";
      return `[Chunk ${index}; ${role}]\n${chunk}`;
    })
    .join("\n\n");

  return CHUNK_CONTEXT_BATCH_PROMPT.replace(
    "{first_chunk_index}",
    String(params.batchStart),
  )
    .replace("{last_chunk_index}", String(targetEnd - 1))
    .replace("{chunks}", passages);
}

function truncateForPrompt(content: string): string {
  return content.length > MAX_PROMPT_CHARS
    ? content.slice(0, MAX_PROMPT_CHARS)
    : content;
}

function buildContextualRetrievalInteraction(params: {
  config: { modelName: string; provider: SupportedProvider };
  requestDescription: string;
  responseText: string;
  usage: {
    inputTokens?: number;
    inputTokenDetails?: {
      noCacheTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    outputTokens?: number;
  };
}) {
  const { config, requestDescription, responseText, usage } = params;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const inputTokens =
    usage.inputTokenDetails?.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens);
  const outputTokens = usage.outputTokens ?? 0;

  return {
    request: {
      model: config.modelName,
      messages: [{ role: "user" as const, content: requestDescription }],
    },
    response: {
      id: `contextual-retrieval-${crypto.randomUUID()}`,
      object: "chat.completion" as const,
      created: Math.floor(Date.now() / 1000),
      model: config.modelName,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: responseText,
            refusal: null,
          },
          finish_reason: "stop" as const,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: inputTokens + cacheReadTokens + cacheWriteTokens,
        completion_tokens: outputTokens,
        total_tokens:
          inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
      },
    },
    model: config.modelName,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

// ===== Internal constants =====

/** Short documents rarely benefit enough to justify more than one call. */
const MIN_CHUNKS_FOR_PER_CHUNK_CONTEXT = 6;

/** Several passages per structured-output call bounds both spend and latency. */
const CHUNK_CONTEXT_BATCH_SIZE = 8;

/** Include section-boundary context without asking the model to summarize it. */
const SURROUNDING_CHUNK_RADIUS = 1;

/**
 * Stable document prefix shared across passage batches. It establishes the
 * document's overall subject while staying small enough to cache cheaply.
 */
const MAX_PROMPT_CHARS = 12_000;

/** Stored context is indexed repeatedly, so keep it from diluting chunk terms. */
const MAX_CONTEXT_CHARS = 600;

const BEDROCK_PROMPT_CACHE_MODEL = /claude|nova-(?:micro|lite|pro|premier)/;

// ===== Prompts =====

const DOCUMENT_CONTEXT_SYSTEM_PROMPT = `You write a short context blurb that will be attached to every excerpt of a document in a search index. Its only job is to help a search engine match excerpts that omit the subject, the product, the system, or the people involved.

Write plain declarative prose. Name the concrete entities: products, systems, teams, customers, ticket identifiers, releases, and the time period the document covers. Do not evaluate or summarize conclusions.`;

const DOCUMENT_CONTEXT_USER_PROMPT = `Write 2-3 sentences situating the document below within its subject matter, so that an excerpt taken from the middle of it can still be matched to a query naming that subject.

Rules:
- State what the document is, what system or topic it concerns, and who it belongs to
- Reuse the document's own terminology; never invent names or facts it does not contain
- Preserve identifiers, ticket numbers, error codes, and version strings verbatim
- No preamble, headings, bullet points, or commentary

Document title:
{document_title}

Document content:
{document_content}`;

const CHUNK_CONTEXT_SYSTEM_PROMPT = `You write short search-index context passages. Each passage must situate one requested chunk within its document so a query naming the relevant subject can match text that omits that subject.

Write plain declarative prose. Reuse only facts and terminology present in the document or supplied chunks. Preserve identifiers, ticket numbers, error codes, and version strings verbatim. Do not evaluate conclusions. Each passage must be at most 2 sentences and must describe its own chunk, not the document as a whole.`;

const CHUNK_CONTEXT_DOCUMENT_PROMPT = `This stable document overview applies to every following passage batch.

Document title:
{document_title}

Document opening:
{document_content}`;

const CHUNK_CONTEXT_BATCH_PROMPT = `Write one context passage for each target chunk from {first_chunk_index} through {last_chunk_index}, inclusive. Return passages in that exact order. Chunks marked "surrounding context only" may identify a section or subject, but must not receive their own output.

{chunks}`;
