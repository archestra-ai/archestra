import {
  type ContextWindowEstimate,
  getModelReadableMimeTypes,
  type ModelInputModality,
  type SupportedProvider,
} from "@archestra/shared";
import type { ModelMessage, ToolSet } from "ai";
import { isSkillSandboxAvailableForAgent } from "@/skills/skill-sandbox-availability";
import type { ChatMessage, ConversationContentKey } from "@/types";
import { projectCappedToolOutputs } from "@/utils/tool-result-cap";
import {
  buildContextCompactionStreamData,
  type ContextCompactionResult,
  type ContextCompactionStreamData,
  compactMessagesForChat,
} from "./compaction/compact-messages";
import { applyPromptCacheBreakpoints } from "./normalization/apply-prompt-cache";
import { buildModelMessagesForProvider } from "./normalization/build-model-messages";
import { prepareMessagesForProvider } from "./normalization/prepare-for-provider";

// All of these fire BEFORE the model stream's `start` chunk. They must be
// transient: a non-transient data part arriving before `start` makes the AI
// SDK open an assistant message under a client-generated id to hold it, and
// on a reattach (refresh, reconnect, backend restart mid-run) each attach
// builds its own such message — rendering the whole turn twice. The client
// consumes all of them via onData state, exactly like the heartbeat, so
// nothing is lost by keeping them out of the message list.
type CompactionStreamEvent =
  | {
      type: "data-context-compaction-start";
      data: { trigger: "auto" };
      transient: true;
    }
  | {
      type: "data-context-compaction-finish";
      data: ContextCompactionStreamData;
      transient: true;
    }
  | {
      type: "data-context-window-estimate";
      data: ContextWindowEstimate;
      transient: true;
    };

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
  /**
   * The conversation's `models` FK, forwarded to compaction so the summary is
   * written by the model the conversation runs on. See
   * `ContextCompactionParams` in `./compaction/compact-messages`.
   */
  modelId?: string | null;
  inputModalities?: ModelInputModality[] | null;
  agentLlmApiKeyId?: string | null;
  systemPrompt?: string;
  /** AI SDK tool definitions included in the main model request. */
  tools?: ToolSet;
  abortSignal?: AbortSignal;
  emit: (event: CompactionStreamEvent) => void;
  /**
   * Skip auto-compaction entirely (no summary generated or persisted). Set for
   * encrypted chats: a compaction summary is derived conversation
   * content and would be stored in plaintext.
   */
  disableCompaction?: boolean;
  /**
   * False for an Anthropic-compatible third-party endpoint (custom base URL,
   * non-Claude model) that rejects Anthropic-only request-body features.
   * Defaults to true (genuine Anthropic / other providers unaffected).
   */
  anthropicNativeEndpoint?: boolean;
  /**
   * The encrypted chat's browser-held key, so its attachment rows can be opened
   * for the provider call. Null for an ordinary chat.
   */
  conversationKey?: ConversationContentKey | null;
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
    disableCompaction = false,
    anthropicNativeEndpoint = true,
    conversationKey = null,
    ...rest
  } = params;
  const compaction = {
    ...rest,
    messages: projectCappedToolOutputs(rest.messages),
  };

  let compactionStarted = false;
  // Encrypted chats skip auto-compaction outright: a summary is
  // derived conversation content, and generating one would both send the
  // history to the summarizer and persist the result in plaintext.
  const compactionResult: ContextCompactionResult = disableCompaction
    ? { messages: compaction.messages, status: "skipped", compaction: null }
    : await compactMessagesForChat({
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
            transient: true,
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
      transient: true,
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
      transient: true,
    });
  }

  // One availability lookup per LLM call (the system-prompt path pays the same),
  // so attachment sandbox pointers are only emitted when the agent can run them.
  //
  // Forced off for an encrypted chat: its uploads are deliberately never staged
  // into the sandbox (see the staging guard in routes.ts), so a pointer telling
  // the model to `ls` for them would name a directory they are not in. This
  // governs attachment pointers only — it is not a sandbox feature switch.
  const sandboxAvailable = conversationKey
    ? false
    : await isSkillSandboxAvailableForAgent({
        userId: compaction.userId,
        organizationId: compaction.organizationId,
        agentId: compaction.agentId ?? undefined,
      });

  const { modelMessages, preparedMessages } =
    await buildModelMessagesForProvider({
      messages: compactionResult.messages,
      provider,
      conversationId,
      ingestibleMimeTypes: getModelReadableMimeTypes(inputModalities, provider),
      anthropicNativeEndpoint,
      sandboxAvailable,
      conversationKey,
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
