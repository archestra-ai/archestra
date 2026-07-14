/**
 * Pure translation between the proxy's OpenAI chat-completions wire format and
 * the Microsoft 365 Copilot Chat API (Microsoft Graph beta).
 *
 * The Graph Chat API is stateful (conversation + per-turn messages), text-only
 * (no tool calling, no model selection), and returns no token usage. The
 * adapter's Graph client (see ./microsoft-365-copilot.ts) creates a fresh
 * conversation per request and uses these helpers to map the payloads:
 * - the latest user message becomes the Graph `message.text`;
 * - the system prompt and all prior turns are serialized into one
 *   `additionalContext` entry (the API has no native history replay);
 * - responses/stream events are mapped back to OpenAI (chunk) JSON with
 *   tokenizer-estimated usage, so cost and metrics paths keep working.
 */
import { getTokenizer } from "@/tokenizers";
import { ApiError, type OpenAi } from "@/types";

type ChatCompletionsRequest = OpenAi.Types.ChatCompletionsRequest;
type ChatCompletionsResponse = OpenAi.Types.ChatCompletionsResponse;
type ChatCompletionChunk = OpenAi.Types.ChatCompletionChunk;
type Usage = OpenAi.Types.Usage;

/** Graph `POST /copilot/conversations/{id}/chat[OverStream]` request body. */
export interface GraphChatBody {
  message: { text: string };
  additionalContext?: Array<{ text: string }>;
  locationHint: { timeZone: string };
}

/**
 * The one string the chat error mapper keys on to classify the proxy's tools
 * rejection as ChatErrorCode.ToolsUnsupported (see routes/chat/errors.ts).
 */
export const MICROSOFT_365_COPILOT_TOOLS_UNSUPPORTED_MESSAGE =
  "Microsoft 365 Copilot does not support tool calling. Remove the tools from this request (or the MCP tools from this agent), or use a different provider for tool-based workflows.";

/**
 * The Graph Chat API has no tool calling at all, so a request that declares
 * tools must fail loudly — silently dropping them would leave agents' MCP
 * tools doing nothing.
 */
export function assertNoTools(request: ChatCompletionsRequest): void {
  const legacyFunctions = (request as { functions?: unknown[] }).functions;
  if (
    (Array.isArray(request.tools) && request.tools.length > 0) ||
    (request.tool_choice !== undefined && request.tool_choice !== "none") ||
    (Array.isArray(legacyFunctions) && legacyFunctions.length > 0)
  ) {
    throw new ApiError(400, MICROSOFT_365_COPILOT_TOOLS_UNSUPPORTED_MESSAGE);
  }
}

/**
 * Maps the stateless OpenAI message history onto the Graph Chat API's
 * single-prompt shape: the latest user message is the prompt, everything
 * before it (system prompt included) rides along as additional context.
 */
export function buildGraphChatBody(
  request: ChatCompletionsRequest,
): GraphChatBody {
  const messages = Array.isArray(request.messages) ? request.messages : [];

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) {
    throw new ApiError(
      400,
      "Microsoft 365 Copilot requires at least one user message in the request.",
    );
  }

  const promptText = messageContentToText(messages[lastUserIndex].content);
  if (!promptText.trim()) {
    throw new ApiError(
      400,
      "Microsoft 365 Copilot requires a non-empty text user message (images and other non-text content are not supported).",
    );
  }

  const instructionParts: string[] = [];
  const historyLines: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (index === lastUserIndex) continue;
    const text = messageContentToText(message.content);
    if (!text.trim()) continue;
    if (message.role === "system" || message.role === "developer") {
      instructionParts.push(text);
    } else if (index < lastUserIndex) {
      historyLines.push(`${message.role}: ${text}`);
    }
    // Messages after the last user turn (e.g. a trailing assistant prefill)
    // have no Graph equivalent and are dropped.
  }

  const contextSections: string[] = [];
  if (instructionParts.length > 0) {
    contextSections.push(`Instructions:\n${instructionParts.join("\n\n")}`);
  }
  if (historyLines.length > 0) {
    contextSections.push(`Conversation so far:\n${historyLines.join("\n")}`);
  }

  return {
    message: { text: promptText },
    ...(contextSections.length > 0
      ? { additionalContext: [{ text: contextSections.join("\n\n") }] }
      : {}),
    // Required by the Chat API. The OpenAI wire format carries no user
    // timezone, so send the one deterministic value available server-side.
    locationHint: { timeZone: "UTC" },
  };
}

/**
 * Extracts Copilot's answer text from a Graph conversation payload (the sync
 * `chat` response, and — observed shapes permitting — a stream event).
 * Handles the documented shape (`messages[]` of
 * `#microsoft.graph.copilotConversationResponseMessage` with `text`) plus
 * defensive fallbacks for single-message payloads.
 */
export function extractGraphResponseText(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;

  const messages = record.messages;
  if (Array.isArray(messages)) {
    // The response echoes the conversation turn; the answer is the last
    // response-typed message (or, defensively, the last one carrying text).
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = extractGraphMessageText(messages[i]);
      if (text !== undefined) return text;
    }
    return undefined;
  }

  return (
    extractGraphMessageText(record) ?? extractGraphMessageText(record.message)
  );
}

/** Builds the OpenAI `chat.completion` response for a Graph sync answer. */
export function graphChatResponseToOpenAi(params: {
  responseText: string;
  model: string;
  completionId: string;
  createdUnixSeconds: number;
  usage: Usage;
}): ChatCompletionsResponse {
  const { responseText, model, completionId, createdUnixSeconds, usage } =
    params;
  return {
    id: completionId,
    object: "chat.completion",
    created: createdUnixSeconds,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: responseText },
        finish_reason: "stop",
      },
    ],
    usage,
  } as ChatCompletionsResponse;
}

/**
 * Fabricates the OpenAI streaming chunk sequence for a fully-known answer:
 * role chunk, one content chunk, then the finish chunk carrying usage (the
 * `stream_options.include_usage` convention). Used both by the sync-endpoint
 * streaming fallback and for stream-final text remainders.
 */
export function completionTextToChunks(params: {
  responseText: string;
  model: string;
  completionId: string;
  createdUnixSeconds: number;
  usage: Usage;
}): ChatCompletionChunk[] {
  const { responseText, model, completionId, createdUnixSeconds, usage } =
    params;
  return [
    makeChunk({
      completionId,
      model,
      createdUnixSeconds,
      delta: { role: "assistant", content: "" },
    }),
    makeChunk({
      completionId,
      model,
      createdUnixSeconds,
      delta: { content: responseText },
    }),
    makeChunk({
      completionId,
      model,
      createdUnixSeconds,
      delta: {},
      finishReason: "stop",
      usage,
    }),
  ];
}

/** Builds a single OpenAI content-delta chunk (streaming translation). */
export function makeContentDeltaChunk(params: {
  deltaText: string;
  model: string;
  completionId: string;
  createdUnixSeconds: number;
}): ChatCompletionChunk {
  const { deltaText, model, completionId, createdUnixSeconds } = params;
  return makeChunk({
    completionId,
    model,
    createdUnixSeconds,
    delta: { content: deltaText },
  });
}

/** Builds the OpenAI role chunk that opens a streamed completion. */
export function makeRoleChunk(params: {
  model: string;
  completionId: string;
  createdUnixSeconds: number;
}): ChatCompletionChunk {
  return makeChunk({
    completionId: params.completionId,
    model: params.model,
    createdUnixSeconds: params.createdUnixSeconds,
    delta: { role: "assistant", content: "" },
  });
}

/** Builds the closing OpenAI chunk carrying finish_reason and usage. */
export function makeFinishChunk(params: {
  model: string;
  completionId: string;
  createdUnixSeconds: number;
  usage: Usage;
}): ChatCompletionChunk {
  return makeChunk({
    completionId: params.completionId,
    model: params.model,
    createdUnixSeconds: params.createdUnixSeconds,
    delta: {},
    finishReason: "stop",
    usage: params.usage,
  });
}

/**
 * The Graph Chat API returns no token counts, so usage is estimated with the
 * provider tokenizer — estimates (never zeros) keep the cost/metrics paths
 * meaningful.
 */
export function estimateUsage(params: {
  request: ChatCompletionsRequest;
  responseText: string;
}): Usage {
  const tokenizer = getTokenizer("microsoft-365-copilot");
  const messages = Array.isArray(params.request.messages)
    ? params.request.messages
    : [];
  const promptTokens = tokenizer.countTokens(messages);
  const completionTokens = tokenizer.countTokens({
    role: "assistant",
    content: params.responseText,
  });
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

// ===== Internal helpers =====

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part === null || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function extractGraphMessageText(message: unknown): string | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  // Request echoes (`copilotConversationRequestMessage`) carry the user's own
  // prompt text — only response messages are Copilot's answer.
  const odataType = record["@odata.type"];
  if (typeof odataType === "string" && /request/i.test(odataType)) {
    return undefined;
  }
  if (typeof record.text === "string" && record.text.length > 0) {
    return record.text;
  }
  return undefined;
}

function makeChunk(params: {
  completionId: string;
  model: string;
  createdUnixSeconds: number;
  delta: Record<string, unknown>;
  finishReason?: "stop";
  usage?: Usage;
}): ChatCompletionChunk {
  return {
    id: params.completionId,
    object: "chat.completion.chunk",
    created: params.createdUnixSeconds,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: params.delta,
        finish_reason: params.finishReason ?? null,
      },
    ],
    ...(params.usage ? { usage: params.usage } : {}),
  } as ChatCompletionChunk;
}
