import {
  type ContextWindowEstimate,
  getModelReadableMimeTypes,
  type ModelInputModality,
  type SupportedProvider,
} from "@archestra/shared";
import {
  convertToModelMessages,
  type ModelMessage,
  type ToolCallPart,
  type ToolResultPart,
  type UIMessage,
} from "ai";
import logger from "@/logging";
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
  //
  // Repair unanswered tool calls after that filter so adjacency checks run
  // against the sequence the provider actually receives.
  const nonEmpty = ensureToolCallsHaveResults(
    modelMessages.filter((message) => !isEmptyAssistantModelMessage(message)),
  );

  return {
    modelMessages: PROVIDERS_REQUIRING_LEADING_USER_TURN.has(params.provider)
      ? ensureLeadingUserTurn(nonEmpty)
      : nonEmpty,
    preparedMessages: providerPreparedMessages,
  };
}

// Owned-app chats are seeded with a synthetic `render_app` assistant tool-call
// as the conversation's first message (see app-chat-conversation.ts), so their
// history opens with an assistant turn. Some providers require the first turn to
// be from the user and reject that seeded shape:
// - `gemini` maps it to a `contents[0]` of role `model` carrying a
//   `functionCall` and 400s with "function call turn comes immediately after a
//   user turn or after a function response turn".
// - `bedrock` (Anthropic models via the Converse API) rejects it with
//   "`tool_use` ids were found without `tool_result` blocks immediately after"
//   — its Converse→messages mapping requires a leading user turn even though
//   native Anthropic and OpenAI accept the assistant-first seed unchanged.
// Prepend a minimal user turn (after any leading system messages, which these
// providers lift out of the message list) so the required leading user turn is
// present without dropping the seed, whose tool result carries the app id the
// app tools need to edit the bound app.
const PROVIDERS_REQUIRING_LEADING_USER_TURN: ReadonlySet<SupportedProvider> =
  new Set(["gemini", "bedrock"]);
const LEADING_USER_TURN_TEXT = "Continue.";

function ensureLeadingUserTurn(messages: ModelMessage[]): ModelMessage[] {
  const firstContentIndex = messages.findIndex(
    (message) => message.role !== "system",
  );
  if (firstContentIndex === -1 || messages[firstContentIndex].role === "user") {
    return messages;
  }

  const leadingUserTurn: ModelMessage = {
    role: "user",
    content: [{ type: "text", text: LEADING_USER_TURN_TEXT }],
  };
  return [
    ...messages.slice(0, firstContentIndex),
    leadingUserTurn,
    ...messages.slice(firstContentIndex),
  ];
}

// Providers reject a history in which an assistant `tool_use` block is not
// answered by a `tool_result` in the message that immediately follows — and
// once such a turn is persisted, every subsequent request in the conversation
// fails the same way. Histories can legitimately contain unanswered calls:
// a tool part parked in `approval-requested` (the user sent a new message
// instead of resolving the approval, or the run was blocked in an autonomous
// session) converts to a tool-call with no result, and provider mappers
// silently drop the SDK's approval bookkeeping parts. Synthesize an
// "interrupted" result for those so the replay stays valid for any provider.
// A call the user just approved/declined (`approval-responded`) is deliberately
// left result-less: the SDK's own approval-resume executes or denies it on this
// request, and a synthetic result would pre-empt that (see the filter below).
const INTERRUPTED_TOOL_RESULT_TEXT =
  "Tool execution was interrupted before it produced a result (for example an unresolved approval request or an aborted run). The tool did not run; do not assume it did.";

function ensureToolCallsHaveResults(messages: ModelMessage[]): ModelMessage[] {
  const repaired: ModelMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    repaired.push(message);

    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    // Results can live inline in the assistant content (provider-executed
    // tools) or in the immediately-following tool message.
    const next = messages[i + 1];
    const followingToolMessage =
      next?.role === "tool" && Array.isArray(next.content) ? next : null;
    const answeredToolCallIds = new Set(
      [...message.content, ...(followingToolMessage?.content ?? [])]
        .filter((part) => part.type === "tool-result")
        .map((part) => part.toolCallId),
    );

    // A tool call whose approval the user just answered is resolved by the AI
    // SDK's own approval-resume on this request: `collectToolApprovals` executes
    // an approved call (and denies a declined one) as long as no tool-result
    // exists for the call yet. Synthesizing an "interrupted" result here would
    // add exactly that result, so the SDK skips the call and the approved tool
    // silently never runs. Treat a call with a matching tool-approval-response
    // as already handled and leave it result-less for the SDK to resolve.
    const approvalRequestToolCallIds = new Map<string, string>();
    for (const part of message.content) {
      if (part.type === "tool-approval-request") {
        approvalRequestToolCallIds.set(part.approvalId, part.toolCallId);
      }
    }
    const approvalRespondedToolCallIds = new Set(
      (followingToolMessage?.content ?? [])
        .filter((part) => part.type === "tool-approval-response")
        .map((part) => approvalRequestToolCallIds.get(part.approvalId))
        .filter((toolCallId): toolCallId is string => toolCallId != null),
    );

    const unansweredToolCalls = message.content.filter(
      (part): part is ToolCallPart =>
        part.type === "tool-call" &&
        part.providerExecuted !== true &&
        !answeredToolCallIds.has(part.toolCallId) &&
        !approvalRespondedToolCallIds.has(part.toolCallId),
    );
    if (unansweredToolCalls.length === 0) {
      continue;
    }

    logger.warn(
      {
        toolCallIds: unansweredToolCalls.map((part) => part.toolCallId),
        toolNames: unansweredToolCalls.map((part) => part.toolName),
      },
      "[buildModelMessages] Synthesized interrupted tool results for unanswered tool calls",
    );

    const syntheticResults: ToolResultPart[] = unansweredToolCalls.map(
      (part) => ({
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: { type: "error-text", value: INTERRUPTED_TOOL_RESULT_TEXT },
      }),
    );

    if (followingToolMessage) {
      repaired.push({
        ...followingToolMessage,
        content: [...followingToolMessage.content, ...syntheticResults],
      });
      i++; // the merged copy replaces the original tool message
    } else {
      repaired.push({ role: "tool", content: syntheticResults });
    }
  }

  return repaired;
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
