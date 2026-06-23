/**
 * Builds the per-category breakdown of an assembled chat request: how many
 * tokens the system prompt, tool schemas, conversation messages, tool results,
 * and file attachments each contribute to the context window — plus the largest
 * individual contributors within each category (which tool, which turn).
 *
 * This powers the Context Window Visualizer. Counts are estimates on the same
 * yardstick as auto-compaction (the provider tokenizer for text, a bytes-per-
 * token heuristic for binary payloads); the provider's exact prompt size
 * arrives later via the per-step `TokenUsage` event.
 */
import {
  CONTEXT_WINDOW_CATEGORIES,
  type ContextWindowBreakdown,
  type ContextWindowCategory,
  type ContextWindowItem,
  type SupportedProvider,
} from "@archestra/shared";
import { getTokenizer, type Tokenizer } from "@/tokenizers";
import type { ChatMessage, ChatMessagePart } from "@/types";
import {
  estimateFileTokens,
  TOKEN_ESTIMATE,
} from "./normalization/estimate-message-tokens";

export const CHARS_PER_TOKEN = TOKEN_ESTIMATE.charsPerToken;
export const PDF_BYTES_PER_TOKEN = TOKEN_ESTIMATE.pdfBytesPerToken;
export const BINARY_BYTES_PER_TOKEN = TOKEN_ESTIMATE.binaryBytesPerToken;
export const IMAGE_TOKEN_MAX_ESTIMATE = TOKEN_ESTIMATE.imageTokenMaxEstimate;

// Keep the streamed payload bounded: ship the biggest contributors per category
// and fold the rest into a single "Other" row so totals still reconcile.
const MAX_ITEMS_PER_CATEGORY = 12;
const MESSAGE_PREVIEW_CHARS = 56;

export function buildContextWindowBreakdown(params: {
  provider: SupportedProvider;
  model: string;
  contextLength: number | null;
  /** Effective input price per token (USD), or null when unknown. */
  inputPricePerToken?: number | null;
  systemPrompt?: string;
  /** AI SDK tool map (toolName -> tool definition) passed to the model. */
  tools?: Record<string, unknown>;
  messages: ChatMessage[];
}): ContextWindowBreakdown {
  const tokenizer = getTokenizer(params.provider);
  const accumulators = emptyAccumulators();

  if (params.systemPrompt) {
    accumulators.system_prompt.total += estimateTextTokens(
      tokenizer,
      params.systemPrompt,
    );
  }

  if (params.tools) {
    for (const [name, tool] of Object.entries(params.tools)) {
      const serialized = serializeToolForEstimate(name, tool);
      if (!serialized) {
        continue;
      }
      addItem(accumulators.tools, {
        label: name,
        tokens: estimateTextTokens(tokenizer, serialized),
      });
    }
  }

  for (const message of params.messages) {
    accumulateMessage({ tokenizer, message, accumulators });
  }

  const segments = CONTEXT_WINDOW_CATEGORIES.map((category) => {
    const accumulator = accumulators[category];
    return {
      category,
      tokens: accumulator.total,
      items: finalizeItems(accumulator.items),
    };
  }).filter((segment) => segment.tokens > 0);

  const usedTokens = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const contextLength =
    params.contextLength && params.contextLength > 0
      ? params.contextLength
      : null;
  // May be negative when the assembled request exceeds the model's context limit.
  const freeTokens = contextLength !== null ? contextLength - usedTokens : null;
  // Clamped to [0, 100]: values > 100 mean over-limit but must not break the bar.
  const usedPercent =
    contextLength !== null
      ? Math.min((usedTokens / contextLength) * 100, 100)
      : null;
  const estimatedInputCostUsd =
    params.inputPricePerToken != null && params.inputPricePerToken > 0
      ? usedTokens * params.inputPricePerToken
      : null;

  return {
    provider: params.provider,
    model: params.model,
    contextLength,
    usedTokens,
    freeTokens,
    usedPercent,
    estimatedInputCostUsd,
    segments,
  };
}

/**
 * Rebuilds the derived fields of an existing breakdown using a provider-exact
 * `inputTokens` count instead of the heuristic estimate. Called after each
 * tool-call step so the visualizer headline stays accurate across multi-step
 * turns while the category proportions keep their initial estimates.
 */
export function refreshBreakdownUsedTokens(
  breakdown: ContextWindowBreakdown,
  inputTokens: number,
  inputPricePerToken: number | null,
): ContextWindowBreakdown {
  const { contextLength, segments } = breakdown;
  const freeTokens =
    contextLength !== null ? contextLength - inputTokens : null;
  const usedPercent =
    contextLength !== null
      ? Math.min((inputTokens / contextLength) * 100, 100)
      : null;
  const estimatedInputCostUsd =
    inputPricePerToken != null && inputPricePerToken > 0
      ? inputTokens * inputPricePerToken
      : null;

  // Scale each segment's token count proportionally so Σsegments ≈ inputTokens
  // and the bar stays visually consistent with the updated total.
  const originalTotal = segments.reduce((sum, s) => sum + s.tokens, 0);
  const scaledSegments =
    originalTotal > 0
      ? segments.map((s) => ({
          ...s,
          tokens: Math.round((s.tokens / originalTotal) * inputTokens),
          items: s.items?.map((item) => ({
            ...item,
            tokens: Math.round((item.tokens / originalTotal) * inputTokens),
          })),
        }))
      : segments;

  return {
    ...breakdown,
    usedTokens: inputTokens,
    freeTokens,
    usedPercent,
    estimatedInputCostUsd,
    segments: scaledSegments,
  };
}

/**
 * Effective input price per token (USD) for a model row, preferring the
 * admin-set custom price over the synced models.dev price. Returns null when
 * no price is configured — the cost row is hidden in that case.
 */
export function resolveInputPricePerToken(
  model: {
    promptPricePerToken: string | null;
    customPricePerMillionInput: string | null;
  } | null,
): number | null {
  if (!model) {
    return null;
  }
  if (model.customPricePerMillionInput) {
    const perMillion = Number(model.customPricePerMillionInput);
    if (Number.isFinite(perMillion) && perMillion > 0) {
      return perMillion / 1_000_000;
    }
  }
  if (model.promptPricePerToken) {
    const perToken = Number(model.promptPricePerToken);
    if (Number.isFinite(perToken) && perToken > 0) {
      return perToken;
    }
  }
  return null;
}

// ============================================================================
// Internal helpers
// ============================================================================

interface CategoryAccumulator {
  total: number;
  items: ContextWindowItem[];
}

function emptyAccumulators(): Record<
  ContextWindowCategory,
  CategoryAccumulator
> {
  return {
    system_prompt: { total: 0, items: [] },
    tools: { total: 0, items: [] },
    messages: { total: 0, items: [] },
    tool_results: { total: 0, items: [] },
    files: { total: 0, items: [] },
  };
}

function accumulateMessage(params: {
  tokenizer: Tokenizer;
  message: ChatMessage;
  accumulators: Record<ContextWindowCategory, CategoryAccumulator>;
}): void {
  const { tokenizer, message, accumulators } = params;
  let messageText = "";

  for (const part of message.parts ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      messageText += `${part.text}\n`;
    } else if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      addItem(accumulators.tool_results, {
        label: part.toolName ?? part.type.replace(/^tool-/, ""),
        tokens: estimateTextTokens(tokenizer, serializeToolPart(part)),
      });
    } else if (part.type === "file") {
      addItem(accumulators.files, {
        label: String(part.filename ?? "file"),
        tokens: estimateFilePartTokens(part),
      });
    }
  }

  const trimmed = messageText.trim();
  if (trimmed) {
    addItem(accumulators.messages, {
      label: previewLabel(message.role, trimmed),
      tokens: estimateTextTokens(tokenizer, messageText),
    });
  }
}

function addItem(accumulator: CategoryAccumulator, item: ContextWindowItem) {
  if (item.tokens <= 0) {
    return;
  }
  accumulator.total += item.tokens;
  accumulator.items.push(item);
}

/** Sort contributors descending and collapse the long tail into "Other (N)". */
function finalizeItems(items: ContextWindowItem[]): ContextWindowItem[] {
  if (items.length === 0) {
    return [];
  }
  const sorted = [...items].sort((a, b) => b.tokens - a.tokens);
  if (sorted.length <= MAX_ITEMS_PER_CATEGORY) {
    return sorted;
  }
  const head = sorted.slice(0, MAX_ITEMS_PER_CATEGORY - 1);
  const tail = sorted.slice(MAX_ITEMS_PER_CATEGORY - 1);
  // Sum conserves the category total: head tokens + otherTokens === accumulator.total.
  const otherTokens = tail.reduce((sum, item) => sum + item.tokens, 0);
  return [...head, { label: `Other (${tail.length})`, tokens: otherTokens }];
}

function previewLabel(role: ChatMessage["role"], text: string): string {
  const roleLabel =
    role === "user"
      ? "You"
      : role === "assistant"
        ? "Assistant"
        : role === "tool"
          ? "Tool"
          : "System";
  const normalized = text.replace(/\s+/g, " ").trim();
  const preview =
    normalized.length > MESSAGE_PREVIEW_CHARS
      ? `${normalized.slice(0, MESSAGE_PREVIEW_CHARS)}…`
      : normalized;
  return `${roleLabel}: ${preview}`;
}

function estimateTextTokens(tokenizer: Tokenizer, text: string): number {
  if (!text) {
    return 0;
  }
  return tokenizer.countTokens([{ role: "user", content: text }] as Parameters<
    typeof tokenizer.countTokens
  >[0]);
}

function serializeToolPart(part: ChatMessagePart): string {
  const output = part.output ?? part.result;
  const header = `[${part.type} ${part.toolName ?? ""} ${part.state ?? ""}]`;
  return output === undefined ? header : `${header} ${safeJson(output)}`;
}

function serializeToolForEstimate(name: string, tool: unknown): string {
  if (!tool || typeof tool !== "object") {
    return "";
  }
  const definition = tool as {
    description?: unknown;
    inputSchema?: { jsonSchema?: unknown };
  };
  const description =
    typeof definition.description === "string" ? definition.description : "";
  const schema = definition.inputSchema?.jsonSchema ?? {};
  return `${name}\n${description}\n${safeJson(schema)}`;
}

function estimateFilePartTokens(part: ChatMessagePart): number {
  const mediaType =
    typeof part.mediaType === "string" && part.mediaType.length > 0
      ? part.mediaType
      : "application/octet-stream";

  // Prefer the pre-computed byte size (set by extractInlineAttachments for
  // attachment-ref URLs, or provided directly). Fall back to measuring the
  // data URL payload when no explicit size is available.
  const byteLength =
    typeof part.fileSize === "number" && part.fileSize > 0
      ? part.fileSize
      : dataUrlByteLength(part.url);

  if (byteLength <= 0) {
    return 0;
  }

  return estimateFileTokens({ mediaType, byteLength });
}

/**
 * Returns the decoded byte length of a `data:` URL payload.
 * - base64 payloads: reverses the 4-chars-per-3-bytes expansion.
 * - plain (URL-encoded) payloads: length in chars approximates byte length.
 * Returns 0 for non-data URLs (attachment refs use `fileSize` instead).
 */
function dataUrlByteLength(url: unknown): number {
  if (typeof url !== "string" || !url.startsWith("data:")) {
    return 0;
  }
  const commaIndex = url.indexOf(",");
  if (commaIndex < 0) {
    return 0;
  }
  const meta = url.slice(5, commaIndex);
  const payload = url.slice(commaIndex + 1);
  return meta.includes(";base64")
    ? Math.floor((payload.length * 3) / 4)
    : payload.length;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
