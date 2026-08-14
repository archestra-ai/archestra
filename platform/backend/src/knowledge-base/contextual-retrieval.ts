import { generateText } from "ai";
import config from "@/config";
import logger from "@/logging";
import {
  getProviderChatInteractionType,
  withKbObservability,
} from "./kb-interaction";
import { resolveRerankerConfig } from "./kb-llm-client";

// ===== Exports =====

/**
 * Summarize a document into a short passage of context that is indexed
 * alongside every chunk of that document.
 *
 * Chunking destroys the context a passage sits in: a chunk reading "the limit
 * was raised to 5,000" is a poor match for "what is the rate limit on the
 * billing API" because neither "rate limit" nor "billing API" appears in it.
 * Prefixing each chunk's indexed text with a document-level summary restores
 * enough of that context for both the embedding and the keyword index to match.
 *
 * Runs once per document at ingest — documents whose content hash is unchanged
 * are skipped by the sync, so a steady-state re-sync costs nothing. Returns
 * `null` whenever the context cannot be produced (no reranking model, a
 * rerank-only model, an empty document, or an LLM failure); callers index the
 * document without it rather than failing the sync.
 */
export async function buildDocumentContext(params: {
  title: string;
  content: string;
  organizationId: string;
  connectorId: string | null;
}): Promise<string | null> {
  const { title, content, organizationId, connectorId } = params;

  if (!config.kb.contextualRetrievalEnabled) return null;
  if (!content.trim()) return null;

  let rerankerConfig: Awaited<ReturnType<typeof resolveRerankerConfig>>;
  try {
    rerankerConfig = await resolveRerankerConfig(organizationId);
  } catch (error) {
    // Contextual retrieval reuses the reranking model and is a best-effort
    // enhancement: an unresolvable config must not fail an ingest. The fault is
    // already surfaced at save time.
    logger.warn(
      {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[ContextualRetrieval] Reranker config unresolvable, indexing without context",
    );
    return null;
  }

  if (!rerankerConfig) {
    logger.debug(
      { organizationId },
      "[ContextualRetrieval] No reranking model configured, indexing without context",
    );
    return null;
  }

  if (rerankerConfig.kind !== "llm") {
    // A dedicated rerank-API model (Cohere Rerank) only scores documents; it
    // cannot generate text. Same degradation as query expansion.
    logger.debug(
      { organizationId },
      "[ContextualRetrieval] Reranking model is rerank-only, indexing without context",
    );
    return null;
  }

  try {
    const result = await withKbObservability({
      operationName: "chat",
      provider: rerankerConfig.provider as Parameters<
        typeof withKbObservability
      >[0]["provider"],
      model: rerankerConfig.modelName,
      source: "knowledge:contextual-retrieval",
      connectorId,
      type: getProviderChatInteractionType(
        rerankerConfig.provider as Parameters<
          typeof getProviderChatInteractionType
        >[0],
      ),
      callback: () =>
        generateText({
          model: rerankerConfig.llmModel,
          system: DOCUMENT_CONTEXT_SYSTEM_PROMPT,
          prompt: DOCUMENT_CONTEXT_USER_PROMPT.replace(
            "{document_title}",
            title,
          ).replace("{document_content}", truncateForPrompt(content)),
        }),
      buildInteraction: (res) =>
        buildContextualRetrievalInteraction(rerankerConfig, title, res),
    });

    return formatContext(result.text);
  } catch (error) {
    logger.warn(
      {
        organizationId,
        connectorId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[ContextualRetrieval] Failed to generate document context, indexing without it",
    );
    return null;
  }
}

/**
 * Determines whether the per-chunk context path should be used for a document
 * based on configuration and the document's length.
 */
export function shouldUsePerChunkContext(chunkCount: number): boolean {
  return (
    config.kb.contextualRetrievalEnabled &&
    config.kb.perChunkContextualRetrievalEnabled &&
    chunkCount >= MIN_CHUNKS_FOR_PER_CHUNK
  );
}

/**
 * Summarize a batch of chunks, returning an array of context passages aligned
 * with the input chunks. Each context passage situates its chunk within the
 * document.
 */
export async function buildChunkContexts(params: {
  title: string;
  content: string;
  chunks: string[];
  organizationId: string;
  connectorId: string | null;
}): Promise<(string | null)[]> {
  const { title, content, chunks, organizationId, connectorId } = params;

  if (chunks.length === 0) return [];
  if (!shouldUsePerChunkContext(chunks.length)) {
    return chunks.map(() => null);
  }

  let rerankerConfig: Awaited<ReturnType<typeof resolveRerankerConfig>>;
  try {
    rerankerConfig = await resolveRerankerConfig(organizationId);
  } catch (error) {
    logger.warn(
      {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[ContextualRetrieval] Reranker config unresolvable, indexing without chunk context",
    );
    return chunks.map(() => null);
  }

  if (!rerankerConfig || rerankerConfig.kind !== "llm") {
    logger.debug(
      { organizationId },
      `[ContextualRetrieval] ${!rerankerConfig ? "No reranking model configured" : "Reranking model is rerank-only"}, indexing without chunk context`,
    );
    return chunks.map(() => null);
  }

  // Rebind to a `const` so the "llm" narrowing above survives being read from
  // inside the loop's closures below — TS re-widens a narrowed `let` there.
  const llmRerankerConfig = rerankerConfig;

  const contexts: (string | null)[] = new Array(chunks.length).fill(null);

  for (let i = 0; i < chunks.length; i += CHUNK_CONTEXT_BATCH_SIZE) {
    const batchChunks = chunks.slice(i, i + CHUNK_CONTEXT_BATCH_SIZE);
    const chunksText = batchChunks
      .map((c, idx) => `[Chunk ${i + idx}]\n${c}`)
      .join("\n\n");

    try {
      const result = await withKbObservability({
        operationName: "chat",
        provider: llmRerankerConfig.provider as Parameters<
          typeof withKbObservability
        >[0]["provider"],
        model: llmRerankerConfig.modelName,
        source: "knowledge:contextual-retrieval",
        connectorId,
        type: getProviderChatInteractionType(
          llmRerankerConfig.provider as Parameters<
            typeof getProviderChatInteractionType
          >[0],
        ),
        callback: () =>
          generateText({
            model: llmRerankerConfig.llmModel,
            system: CHUNK_CONTEXT_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: CHUNK_CONTEXT_USER_PROMPT_DOC.replace(
                      "{document_title}",
                      title,
                    ).replace("{document_content}", truncateForPrompt(content)),
                    providerOptions: {
                      anthropic: { cacheControl: { type: "ephemeral" } },
                    },
                  },
                  {
                    type: "text",
                    text: CHUNK_CONTEXT_USER_PROMPT_CHUNKS.replace(
                      "{chunks}",
                      chunksText,
                    ),
                  },
                ],
              },
            ],
          }),
        buildInteraction: (res) =>
          buildContextualRetrievalInteraction(
            llmRerankerConfig,
            `[${batchChunks.length} chunks]`,
            res,
          ),
      });

      const lines = result.text.split("\n");
      let currentChunkIdx = -1;
      let currentContext = "";

      const finalizeChunk = () => {
        if (currentChunkIdx >= i && currentChunkIdx < i + batchChunks.length) {
          contexts[currentChunkIdx] = formatContext(currentContext);
        }
        currentContext = "";
      };

      for (const line of lines) {
        const match = line.match(/^\[Chunk (\d+)\](.*)/);
        if (match) {
          finalizeChunk();
          currentChunkIdx = parseInt(match[1], 10);
          currentContext = match[2].trim();
        } else if (currentChunkIdx !== -1 && line.trim()) {
          currentContext += (currentContext ? " " : "") + line.trim();
        }
      }
      finalizeChunk();
    } catch (error) {
      logger.warn(
        {
          organizationId,
          connectorId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[ContextualRetrieval] Failed to generate chunk context, indexing without it",
      );
    }
  }

  return contexts;
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

// ===== Internal constants =====

/**
 * Minimum number of chunks a document must have to justify the cost of the
 * per-chunk LLM passes instead of the single document-level pass.
 */
const MIN_CHUNKS_FOR_PER_CHUNK = 6;

/**
 * How many chunks are sent to the model per call for per-chunk context generation.
 */
const CHUNK_CONTEXT_BATCH_SIZE = 8;

/**
 * How much of a document is shown to the summarizer. A document-level summary
 * only needs the opening — enough to establish what the document is, who owns
 * it, and what it covers — and reading the whole of a large document would cost
 * more than the retrieval gain is worth.
 */
const MAX_PROMPT_CHARS = 12_000;

/**
 * Ceiling on the stored context. It is prepended to the indexed text of every
 * chunk in the document, so an over-long context would dilute the chunk's own
 * terms in both the embedding and the tsvector.
 */
const MAX_CONTEXT_CHARS = 600;

// ===== Internal helpers =====

function truncateForPrompt(content: string): string {
  return content.length > MAX_PROMPT_CHARS
    ? content.slice(0, MAX_PROMPT_CHARS)
    : content;
}

function buildContextualRetrievalInteraction(
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
      id: `contextual-retrieval-${crypto.randomUUID()}`,
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

const CHUNK_CONTEXT_SYSTEM_PROMPT = `You write short context passages that will be prepended to excerpts (chunks) of a document in a search index. Your job is to situate each chunk within the wider document so that a search query naming a subject can match a chunk that discusses that subject without explicitly naming it.

You will be given the document title, the document content, and a numbered list of chunks from that document.

Output exactly one context passage per chunk, prefixed with the chunk's number like this:
[Chunk X] The context passage...

Write plain declarative prose (2-3 sentences max per chunk). Name the concrete entities: products, systems, teams, customers, and the time period. Do not evaluate or summarize conclusions.`;

const CHUNK_CONTEXT_USER_PROMPT_DOC = `Document title:
{document_title}

Document content:
{document_content}`;

const CHUNK_CONTEXT_USER_PROMPT_CHUNKS = `Here are the chunks:

{chunks}`;
