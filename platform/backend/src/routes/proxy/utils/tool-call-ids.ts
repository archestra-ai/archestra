import { createHash } from "node:crypto";
import type { OpenAi } from "@/types";

/**
 * Clients keep a conversation's tool-call ids and replay them to whichever
 * model the conversation moves to, so an id that one provider minted can reach
 * a provider that rejects it. The Gemini translation signs its ids
 * (`encodeSignedToolCallId`): they run to hundreds of characters and contain a
 * dot. OpenAI accepts at most 64 characters, and Anthropic and Bedrock accept
 * only `[a-zA-Z0-9_-]`. The client keeps the rejected id in its history, so
 * every later turn fails the same way.
 *
 * The adapters replace such an id on the upstream request only. The client,
 * the policy checks and the tool-result updates keep the id the client sent.
 * The replacement is a digest of the whole id: the same id maps the same way on
 * every turn, so a call and its result still pair, and different ids stay
 * different.
 */
const MAX_TOOL_CALL_ID_LENGTH = 64;
const WORD_TOOL_CALL_ID = /^[a-zA-Z0-9_-]+$/;

/** An id Anthropic and Bedrock accept: `[a-zA-Z0-9_-]`, at most 64 of them. */
export function wordToolCallId(id: string): string {
  if (id === "") return id;
  return id.length <= MAX_TOOL_CALL_ID_LENGTH && WORD_TOOL_CALL_ID.test(id)
    ? id
    : digestToolCallId(id);
}

/** Chat Completions messages whose tool-call ids OpenAI accepts. */
export function withOpenAiChatToolCallIds(
  messages: OpenAi.Types.ChatCompletionsRequest["messages"],
): OpenAi.Types.ChatCompletionsRequest["messages"] {
  return messages.map((message) => {
    if (message.role === "tool") {
      const toolCallId = openAiToolCallId(message.tool_call_id);
      return toolCallId === message.tool_call_id
        ? message
        : { ...message, tool_call_id: toolCallId };
    }
    if (
      message.role === "assistant" &&
      message.tool_calls?.some((call) => openAiToolCallId(call.id) !== call.id)
    ) {
      return {
        ...message,
        tool_calls: message.tool_calls.map((call) => ({
          ...call,
          id: openAiToolCallId(call.id),
        })),
      };
    }
    return message;
  });
}

/**
 * A Responses input item whose call id OpenAI accepts: the item itself, or a
 * copy with a fitted `call_id` and without an `id` over the limit. That id is
 * dropped, not replaced: OpenAI did not mint it, the field is optional, and
 * OpenAI rejects an id without the prefix of the item's type.
 */
export function withOpenAiResponsesToolCallIds<T>(item: T): T | Omit<T, "id"> {
  if (typeof item !== "object" || item === null) return item;
  const record = item as Record<string, unknown>;
  if (typeof record.call_id !== "string") return item;
  const callId = openAiToolCallId(record.call_id);
  const dropId =
    typeof record.id === "string" && record.id.length > MAX_TOOL_CALL_ID_LENGTH;
  if (callId === record.call_id && !dropId) return item;
  const fitted: Record<string, unknown> = { ...record, call_id: callId };
  if (dropId) delete fitted.id;
  return fitted as Omit<T, "id">;
}

/** An id an OpenAI wire accepts: any characters, at most 64 of them. */
function openAiToolCallId(id: string): string {
  return id.length > MAX_TOOL_CALL_ID_LENGTH ? digestToolCallId(id) : id;
}

// `call_` and 32 hex digits: 37 characters, which also fits the 40-character
// limit older reports give for Chat Completions.
function digestToolCallId(id: string): string {
  return `call_${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}
