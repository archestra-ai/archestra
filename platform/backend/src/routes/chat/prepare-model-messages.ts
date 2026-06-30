import {
  type ContextWindowEstimate,
  getModelReadableMimeTypes,
  type ModelInputModality,
  type SupportedProvider,
} from "@archestra/shared";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { isSkillSandboxAvailableForAgent } from "@/skills/skill-sandbox-availability";
import type { ChatMessage } from "@/types";
import {
  buildContextCompactionStreamData,
  type ContextCompactionStreamData,
  compactMessagesForChat,
} from "./context-compaction";
import { applyPromptCacheBreakpoints } from "./normalization/apply-prompt-cache";
import { assertRequestWithinProviderPayloadLimit } from "./normalization/enforce-request-size-limit";
import { materializeAttachments } from "./normalization/materialize-attachments";
import { prepareMessagesForProvider } from "./normalization/prepare-for-provider";

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
  inputModalities?: ModelInputModality[] | null;
  agentLlmApiKeyId?: string | null;
  systemPrompt?: string;
  abortSignal?: AbortSignal;
  emit: (event: CompactionStreamEvent) => void;
  /**
   * False for an Anthropic-compatible third-party endpoint (custom base URL,
   * non-Claude model) that rejects Anthropic-only request-body features.
   * Defaults to true (genuine Anthropic / other providers unaffected).
   */
  anthropicNativeEndpoint?: boolean;
}): Promise<{
  modelMessages: ModelMessage[];
  /**
   * Provider-prepared, parts-bearing messages (post `prepareMessagesForProvider`,
   * pre-conversion) — the closest representation of what is sent, with inlineable
   * text documents already rewritten to text. Used by the caller to build the
   * context-window breakdown; the converted `modelMessages` carry no `.parts`.
   */
  preparedMessages: ChatMessage[];
}> {
  const {
    provider,
    selectedModel,
    inputModalities,
    conversationId,
    emit,
    anthropicNativeEndpoint = true,
    ...compaction
  } = params;

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

  // One availability lookup per LLM call (the system-prompt path pays the same),
  // so attachment sandbox pointers are only emitted when the agent can run them.
  const sandboxAvailable = await isSkillSandboxAvailableForAgent({
    userId: compaction.userId,
    organizationId: compaction.organizationId,
    agentId: compaction.agentId ?? undefined,
  });

  const { modelMessages, preparedMessages } =
    await buildModelMessagesForProvider({
      messages: compactionResult.messages,
      provider,
      conversationId,
      ingestibleMimeTypes: getModelReadableMimeTypes(inputModalities),
      anthropicNativeEndpoint,
      sandboxAvailable,
    });

  return {
    modelMessages: applyPromptCacheBreakpoints({
      provider,
      model: selectedModel,
      anthropicNativeEndpoint,
      messages: modelMessages,
    }),
    preparedMessages,
  };
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
  ingestibleMimeTypes?: Set<string>;
  anthropicNativeEndpoint?: boolean;
  sandboxAvailable: boolean;
}) {
  const anthropicNativeEndpoint = params.anthropicNativeEndpoint ?? true;
  // `cache_control` is inert for non-Anthropic SDKs, so keep emitting it there;
  // only suppress for an Anthropic-compatible endpoint that rejects the marker.
  const applyAnthropicCacheControl =
    params.provider !== "anthropic" || anthropicNativeEndpoint;
  // Re-inline attachment refs as base64 data URLs for the LLM call (with
  // Anthropic cache_control marker). Refs are filtered to attachments owned
  // by `conversationId` so a client can't reference another conversation's
  // attachment id. Legacy inline data URLs pass through unchanged. Returns a
  // deep copy — the original messages keep their refs for any subsequent
  // persistence step.
  const materialized = await materializeAttachments({
    messages: params.messages,
    conversationId: params.conversationId,
    ingestibleMimeTypes: params.ingestibleMimeTypes,
    applyAnthropicCacheControl,
    rerouteBinaryDocsToSandbox:
      params.provider === "anthropic" && !anthropicNativeEndpoint,
    sandboxAvailable: params.sandboxAvailable,
  });
  // Reject oversized inline attachments here, before the provider call, so the
  // user gets an actionable size error instead of a generic provider rejection.
  assertRequestWithinProviderPayloadLimit({
    messages: materialized,
    provider: params.provider,
  });
  const providerPreparedMessages = prepareMessagesForProvider({
    messages: materialized,
    provider: params.provider,
    anthropicNativeEndpoint,
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
  return {
    modelMessages: modelMessages.filter(
      (message) => !isEmptyAssistantModelMessage(message),
    ),
    preparedMessages: providerPreparedMessages,
  };
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
