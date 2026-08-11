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
