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
} from "@shared";
import { getTokenizer, type Tokenizer } from "@/tokenizers";
import type { ChatMessage, ChatMessagePart } from "@/types";

// Mirrors the heuristics in context-compaction's token estimate so the
// visualizer's total stays consistent with what triggers auto-compaction.
const CHARS_PER_TOKEN = 4;
const PDF_BYTES_PER_TOKEN = 12;
const BINARY_BYTES_PER_TOKEN = 4;

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
  const freeTokens =
    contextLength !== null ? Math.max(contextLength - usedTokens, 0) : null;
  const usedPercent =
    contextLength !== null
      ? Math.min((usedTokens / contextLength) * 100, 100)
      : null;
  const estimatedInputCostUsd =
    params.inputPricePerToken && params.inputPricePerToken > 0
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

/** Sort contributors descending and collapse the long tail into "Other". */
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
  const byteLength =
    typeof part.fileSize === "number" && part.fileSize > 0
      ? part.fileSize
      : dataUrlByteLength(part.url);
  if (byteLength <= 0) {
    return 0;
  }

  const bytesPerToken =
    mediaType === "application/pdf"
      ? PDF_BYTES_PER_TOKEN
      : isTextLikeMediaType(mediaType)
        ? CHARS_PER_TOKEN
        : BINARY_BYTES_PER_TOKEN;
  return Math.ceil(byteLength / bytesPerToken);
}

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
  // base64 expands ~4 chars per 3 bytes; non-base64 payloads are URL-encoded text
  return meta.includes(";base64")
    ? Math.floor((payload.length * 3) / 4)
    : payload.length;
}

function isTextLikeMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/xml" ||
    mediaType === "application/csv"
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
