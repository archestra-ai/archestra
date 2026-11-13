import type { SupportedProvider } from "@archestra/shared";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { ensureToolCallsHaveResults } from "@/agents/tool-call-results";
import type { ChatMessage, ConversationContentKey } from "@/types";
import {
  assertRequestWithinProviderPayloadLimit,
  chatAttachmentInlineByteLimit,
  providerImageAttachmentLimitBytes,
} from "./enforce-request-size-limit";
import { materializeAttachments } from "./materialize-attachments";
import { prepareMessagesForProvider } from "./prepare-for-provider";

/**
 * Providers whose chat-completion request schema has no content part able to
 * carry a binary document — text and images only. Sending a PDF to one is a
 * guaranteed 400, and a model row with no recorded input modalities defaults to
 * "reads PDFs", so the file has to be diverted here rather than trusted to the
 * modality set.
 *
 * Membership is asserted from a provider's own request schema, never inferred:
 * `zhipuai`'s content part is a union of text and `image_url`
 * (`types/llm-providers/zhipuai/messages.ts`). Add a provider only after
 * reading its schema — a wrong entry silently stops sending documents that
 * would have worked.
 */
const PROVIDERS_WITHOUT_DOCUMENT_CONTENT_PARTS: ReadonlySet<SupportedProvider> =
  new Set<SupportedProvider>(["zhipuai"]);

/** Shared provider normalization for ordinary turns and in-context compaction. */
export async function buildModelMessagesForProvider(params: {
  messages: ChatMessage[];
  provider: SupportedProvider;
  conversationId: string;
  ingestibleMimeTypes?: Set<string>;
  anthropicNativeEndpoint?: boolean;
  sandboxAvailable: boolean;
  conversationKey?: ConversationContentKey | null;
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
  // What we may send is bounded by our own inline budget and, where the
  // provider publishes one, its documented request ceiling — whichever is
  // smaller. Anything above stays in the Files panel rather than being sent
  // and refused.
  const inlineByteLimit = chatAttachmentInlineByteLimit(params.provider);
  const providerImageLimit = providerImageAttachmentLimitBytes(params.provider);
  const inlineImageByteLimit = Math.min(
    inlineByteLimit,
    providerImageLimit ?? Number.POSITIVE_INFINITY,
  );
  const materialized = await materializeAttachments({
    messages: params.messages,
    conversationId: params.conversationId,
    ingestibleMimeTypes: params.ingestibleMimeTypes,
    applyAnthropicCacheControl,
    rerouteBinaryDocsToSandbox:
      (params.provider === "anthropic" && !anthropicNativeEndpoint) ||
      PROVIDERS_WITHOUT_DOCUMENT_CONTENT_PARTS.has(params.provider),
    sandboxAvailable: params.sandboxAvailable,
    inlineByteLimit,
    inlineImageByteLimit,
    conversationKey: params.conversationKey ?? null,
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
