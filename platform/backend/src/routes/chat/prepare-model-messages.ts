import type {
  ContextWindowEstimate,
  SupportedProvider,
} from "@archestra/shared";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import type { ChatMessage, ChatMessagePart } from "@/types";
import {
  buildContextCompactionStreamData,
  type ContextCompactionStreamData,
  compactMessagesForChat,
} from "./context-compaction";
import { applyPromptCacheBreakpoints } from "./normalization/apply-prompt-cache";
import { materializeAttachments } from "./normalization/materialize-attachments";

type CompactionStreamEvent =
  | { type: "data-context-compaction-start"; data: { trigger: "auto" } }
  | {
      type: "data-context-compaction-finish";
      data: ContextCompactionStreamData;
    }
  | { type: "data-context-window-estimate"; data: ContextWindowEstimate };

/**
 * Compact the (already normalized) history when it is over the auto-compaction
 * threshold, then materialize attachment refs, apply provider message shims,
 * convert to ModelMessage[], and mark prompt-cache breakpoints. Compaction
 * progress and the context-window estimate stream to the client via `emit`.
 */
export async function buildModelMessages(params: {
  messages: ChatMessage[];
  conversationId: string;
  organizationId: string;
  userId: string;
  agentId?: string | null;
  provider: SupportedProvider;
  selectedModel: string;
  agentLlmApiKeyId?: string | null;
  systemPrompt?: string;
  abortSignal?: AbortSignal;
  emit: (event: CompactionStreamEvent) => void;
}): Promise<ModelMessage[]> {
  const { provider, selectedModel, conversationId, emit, ...compaction } =
    params;

  let compactionStarted = false;
  const compactionResult = await compactMessagesForChat({
    ...compaction,
    conversationId,
    provider,
    selectedModel,
    trigger: "auto",
    onCompactionStart: () => {
      compactionStarted = true;
      emit({
        type: "data-context-compaction-start",
        data: { trigger: "auto" },
      });
    },
  });

  if (
    compactionStarted ||
    compactionResult.status === "created" ||
    compactionResult.status === "failed"
  ) {
    emit({
      type: "data-context-compaction-finish",
      data: buildContextCompactionStreamData(compactionResult),
    });
  }

  // Seed the context indicator with the size of what we are about to send, on
  // the same yardstick that triggers auto-compaction, so the bar is correct
  // before the first token (and reflects a compaction drop immediately).
  // Per-step usage refines it later.
  if (compactionResult.inputTokenEstimate !== undefined) {
    emit({
      type: "data-context-window-estimate",
      data: {
        estimatedTokens: compactionResult.inputTokenEstimate,
      } satisfies ContextWindowEstimate,
    });
  }

  return applyPromptCacheBreakpoints({
    provider,
    model: selectedModel,
    messages: await buildModelMessagesForProvider({
      messages: compactionResult.messages,
      provider,
      conversationId,
    }),
  });
}

export const __test = {
  buildModelMessagesForProvider,
  prepareMessagesForProvider,
};

// ===== Internal helpers =====

async function buildModelMessagesForProvider(params: {
  messages: ChatMessage[];
  provider: SupportedProvider;
  conversationId: string;
}) {
  // Re-inline attachment refs as base64 data URLs for the LLM call (with
  // Anthropic cache_control marker). Refs are filtered to attachments owned
  // by `conversationId` so a client can't reference another conversation's
  // attachment id. Legacy inline data URLs pass through unchanged. Returns a
  // deep copy — the original messages keep their refs for any subsequent
  // persistence step.
  const materialized = await materializeAttachments(
    params.messages,
    params.conversationId,
  );
  const providerPreparedMessages = prepareMessagesForProvider({
    messages: materialized,
    provider: params.provider,
  });

  // Cast to UIMessage[] - ChatMessage is structurally compatible at runtime.
  const modelMessages = await convertToModelMessages(
    providerPreparedMessages as unknown as Omit<UIMessage, "id">[],
  );

  // convertToModelMessages can split an assistant turn at `step-start` and drop
  // provider-invisible parts (data-*, tool-ui-start), yielding an assistant
  // message with empty content that some providers reject. Drop those here —
  // after Bedrock's `(no content)` padding above, so its intentional
  // placeholders survive while other providers never see an empty turn. An
  // empty assistant message has no tool-call block, so removing it cannot
  // orphan a tool result.
  return modelMessages.filter(
    (message) => !isEmptyAssistantModelMessage(message),
  );
}

function prepareMessagesForProvider(params: {
  messages: ChatMessage[];
  provider: SupportedProvider;
}): ChatMessage[] {
  const { messages, provider } = params;

  if (provider === "anthropic") {
    return messages.map(normalizeAnthropicMessageFileParts);
  }

  if (provider === "bedrock") {
    return messages
      .map(normalizeBedrockMessageFileParts)
      .map((message) =>
        ensureBedrockMessageHasContent(
          ensureBedrockUserMessageHasTextPart(message),
        ),
      );
  }

  return messages;
}

function isEmptyAssistantModelMessage(message: {
  role: string;
  content: unknown;
}): boolean {
  if (message.role !== "assistant") {
    return false;
  }

  const { content } = message;
  if (typeof content === "string") {
    return content.trim().length === 0;
  }

  if (Array.isArray(content)) {
    // empty, or only blank text parts — any tool-call/file/reasoning part is
    // real provider-visible content and keeps the message.
    return content.every(
      (part) =>
        part?.type === "text" &&
        (typeof part.text !== "string" || part.text.trim().length === 0),
    );
  }

  // unknown content shape: keep, to avoid dropping something the provider needs.
  return false;
}

function normalizeAnthropicMessageFileParts(message: ChatMessage): ChatMessage {
  if (!message.parts?.length) {
    return message;
  }

  let changed = false;
  const parts = message.parts.map((part) => {
    const normalizedPart = normalizeAnthropicFilePart(part);
    if (normalizedPart !== part) {
      changed = true;
    }
    return normalizedPart;
  });

  return changed ? { ...message, parts } : message;
}

function normalizeBedrockMessageFileParts(message: ChatMessage): ChatMessage {
  if (!message.parts?.length) {
    return message;
  }

  let changed = false;
  const parts = message.parts.map((part) => {
    const normalizedPart = normalizeBedrockFilePart(part);
    if (normalizedPart !== part) {
      changed = true;
    }
    return normalizedPart;
  });

  return changed ? { ...message, parts } : message;
}

// Bedrock rejects user messages that contain a file/document block but no text
// block ("A text block must be included when using documents."). When the user
// sends a file with an empty prompt, prepend a placeholder so the request is
// accepted.
function ensureBedrockUserMessageHasTextPart(
  message: ChatMessage,
): ChatMessage {
  if (message.role !== "user" || !message.parts?.length) {
    return message;
  }

  let hasFilePart = false;
  let hasNonEmptyTextPart = false;
  for (const part of message.parts) {
    if (part.type === "file") {
      hasFilePart = true;
    } else if (
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0
    ) {
      hasNonEmptyTextPart = true;
    }
  }

  if (!hasFilePart || hasNonEmptyTextPart) {
    return message;
  }

  return {
    ...message,
    parts: [
      { type: "text", text: BEDROCK_DOCUMENT_PLACEHOLDER_TEXT },
      ...message.parts,
    ],
  };
}

/**
 * Workaround for AI SDK Bedrock conversion sending empty assistant content.
 *
 * The AI SDK can split assistant UI messages at `step-start` boundaries, then
 * drop provider-invisible parts during Bedrock conversion and send
 * `content: []`. Keep this until the upstream provider fix is released:
 * https://github.com/vercel/ai/issues/15248
 * https://github.com/vercel/ai/pull/15250
 */
function ensureBedrockMessageHasContent(message: ChatMessage): ChatMessage {
  if (message.role === "system" || message.role === "tool") {
    return message;
  }
  if (message.role === "assistant") {
    return ensureBedrockAssistantMessageHasContent(message);
  }
  if (message.parts?.some(producesBedrockContentBlock)) {
    return message;
  }

  return {
    ...message,
    parts: message.parts
      ? [...message.parts, createBedrockEmptyContentPlaceholder()]
      : [createBedrockEmptyContentPlaceholder()],
  };
}

function ensureBedrockAssistantMessageHasContent(
  message: ChatMessage,
): ChatMessage {
  if (!message.parts?.length) {
    return {
      ...message,
      parts: [createBedrockEmptyContentPlaceholder()],
    };
  }

  let changed = false;
  let blockHasAnyPart = false;
  let blockHasContent = false;
  const parts: ChatMessagePart[] = [];

  const padCurrentBlockIfEmpty = () => {
    if (blockHasAnyPart && !blockHasContent) {
      parts.push(createBedrockEmptyContentPlaceholder());
      changed = true;
    }
    blockHasAnyPart = false;
    blockHasContent = false;
  };

  for (const part of message.parts) {
    if (part.type === "step-start") {
      padCurrentBlockIfEmpty();
      parts.push(part);
      continue;
    }

    parts.push(part);
    blockHasAnyPart = true;
    if (producesBedrockContentBlock(part)) {
      blockHasContent = true;
    }
  }

  padCurrentBlockIfEmpty();

  return changed ? { ...message, parts } : message;
}

function createBedrockEmptyContentPlaceholder(): ChatMessagePart {
  return {
    type: "text",
    text: BEDROCK_EMPTY_CONTENT_PLACEHOLDER_TEXT,
  };
}

// Mirrors the AI SDK's UI-to-model conversion plus Bedrock's converter:
// data/control parts are ignored without a converter, streaming tool inputs are
// dropped, and empty text/reasoning blocks are not provider-visible content.
function producesBedrockContentBlock(part: ChatMessagePart): boolean {
  if (part.type === "text") {
    return typeof part.text === "string" && part.text.trim().length > 0;
  }
  if (part.type === "file") {
    return true;
  }
  if (part.type === "reasoning") {
    const providerMetadata =
      (part.providerMetadata as { bedrock?: unknown } | undefined) ??
      (part.providerOptions as { bedrock?: unknown } | undefined);
    const bedrock = providerMetadata?.bedrock as
      | { signature?: unknown; redactedData?: unknown }
      | undefined;
    return Boolean(bedrock?.signature || bedrock?.redactedData);
  }
  if (part.type.startsWith("tool-")) {
    return part.state !== "input-streaming";
  }
  return false;
}

const BEDROCK_DOCUMENT_PLACEHOLDER_TEXT =
  "Please review the attached document.";
const BEDROCK_EMPTY_CONTENT_PLACEHOLDER_TEXT = "(no content)";

function normalizeAnthropicFilePart(part: ChatMessagePart): ChatMessagePart {
  if (
    part.type !== "file" ||
    typeof part.mediaType !== "string" ||
    !isAnthropicTextDocumentMimeType(part.mediaType)
  ) {
    return part;
  }

  return {
    ...part,
    mediaType: "text/plain",
    url: normalizeDataUrlMediaType({
      url: typeof part.url === "string" ? part.url : undefined,
      fromMediaType: part.mediaType,
      toMediaType: "text/plain",
    }),
  };
}

function isAnthropicTextDocumentMimeType(mediaType: string): boolean {
  return (
    mediaType === "text/csv" ||
    mediaType === "text/markdown" ||
    mediaType === "application/csv" ||
    mediaType === "application/vnd.ms-excel" ||
    mediaType === "application/json"
  );
}

function normalizeBedrockFilePart(part: ChatMessagePart): ChatMessagePart {
  if (
    part.type !== "file" ||
    typeof part.mediaType !== "string" ||
    !isBedrockTextNormalizableMimeType(part.mediaType)
  ) {
    return part;
  }

  return {
    ...part,
    mediaType: "text/plain",
    url: normalizeDataUrlMediaType({
      url: typeof part.url === "string" ? part.url : undefined,
      fromMediaType: part.mediaType,
      toMediaType: "text/plain",
    }),
  };
}

// MIMEs that contain text content but aren't in Bedrock's natively supported
// document list — normalize to text/plain so the AI SDK can relay them.
function isBedrockTextNormalizableMimeType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType === "application/csv";
}

function normalizeDataUrlMediaType(params: {
  url: string | undefined;
  fromMediaType: string;
  toMediaType: string;
}): string | undefined {
  const { url, fromMediaType, toMediaType } = params;

  if (!url?.startsWith(`data:${fromMediaType};`)) {
    return url;
  }

  return url.replace(`data:${fromMediaType};`, `data:${toMediaType};`);
}
