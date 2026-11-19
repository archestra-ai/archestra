/**
 * Workaround for provider context length errors.
 * When a provider/gateway returns a 400 describing the context limit
 * (vLLM/LiteLLM "maximum input length of N tokens", OpenRouter-style
 * "maximum context length is N tokens"), we parse the limit, trim
 * messages, and retry the request.
 */
import type { SupportedProvider } from "@archestra/shared";
import { APICallError, type DataContent, type ModelMessage } from "ai";
import { sliceUtf8, utf8Length } from "@/utils/tool-result-cap";
import {
  estimateFileTokens,
  TOKEN_ESTIMATE,
} from "./normalization/estimate-message-tokens";

const CHARS_PER_TOKEN = TOKEN_ESTIMATE.charsPerToken;

// Trim below the reported limit so the retried request clears it even with
// estimation error; see the charsPerToken derivation in trimMessagesToTokenLimit.
const CONTEXT_TRIM_HEADROOM_RATIO = 0.9;

/**
 * Gemini can emit tool-call chunks before any text. Probing textStream to detect
 * context errors can consume that first tool-call event, which hides the
 * in-progress tool indicator in chat. Skip the probe there.
 */
export function shouldProbeTextStreamForContextTrimRetry(
  provider: SupportedProvider,
): boolean {
  return provider !== "gemini";
}

export interface ContextLengthError {
  maxInputTokens: number;
  /**
   * Token count the provider says the rejected request carried. Used to derive
   * the payload's real chars-per-token ratio when trimming (token-dense JSON
   * payloads run well under the 4-chars-per-token default).
   */
  requestedTokens?: number;
}

/**
 * Parse the token limit (and, when reported, the rejected request's token
 * count) from provider context-length error responses. Matches:
 * - vLLM/LiteLLM: "You passed 8193 input tokens ... maximum input length of 8192 tokens"
 * - OpenRouter-style gateways: "maximum context length is 262144 tokens.
 *   However, you requested about 285869 tokens"
 * - Anthropic family: "prompt is too long: 1000034 tokens > 1000000 maximum"
 * - Anthropic family: "input length and max_tokens exceed context limit:
 *   190000 + 20000 > 200000"
 *
 * The Anthropic shapes arrive both from the native API and from resellers that
 * relay the model's own message verbatim — Bedrock wraps it as "The model
 * returned the following errors: prompt is too long: …". Matching on the
 * message rather than the envelope therefore covers every host of a Claude
 * model at once, which is what makes the trim-and-retry recovery reachable for
 * Bedrock at all.
 */
export function parseContextLengthError(
  error: unknown,
): ContextLengthError | null {
  let body: string | undefined;

  if (APICallError.isInstance(error)) {
    body = (error as InstanceType<typeof APICallError>).responseBody;
  }
  if (!body) {
    body = error instanceof Error ? error.message : undefined;
  }
  if (!body) return null;

  const vllmMatch = body.match(/maximum input length of (\d+)/);
  if (vllmMatch) {
    const requested = body.match(/[Yy]ou passed (\d+) input tokens/);
    return {
      maxInputTokens: Number.parseInt(vllmMatch[1], 10),
      requestedTokens: requested
        ? Number.parseInt(requested[1], 10)
        : undefined,
    };
  }

  const gatewayMatch = body.match(/maximum context length is (\d+)/);
  if (gatewayMatch) {
    const requested = body.match(/[Yy]ou requested (?:about )?(\d+) tokens/);
    return {
      maxInputTokens: Number.parseInt(gatewayMatch[1], 10),
      requestedTokens: requested
        ? Number.parseInt(requested[1], 10)
        : undefined,
    };
  }

  const anthropicPromptMatch = body.match(
    /prompt is too long:\s*(\d+)\s*tokens\s*>\s*(\d+)\s*maximum/i,
  );
  if (anthropicPromptMatch) {
    return {
      maxInputTokens: Number.parseInt(anthropicPromptMatch[2], 10),
      requestedTokens: Number.parseInt(anthropicPromptMatch[1], 10),
    };
  }

  // The output reservation is counted against the window alongside the input,
  // so the budget the retry has to fit into is the window minus that
  // reservation — trimming to the bare window would be rejected again.
  const anthropicMaxTokensMatch = body.match(
    /input length and max_tokens exceed context limit:\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/i,
  );
  if (anthropicMaxTokensMatch) {
    const inputTokens = Number.parseInt(anthropicMaxTokensMatch[1], 10);
    const reservedOutputTokens = Number.parseInt(
      anthropicMaxTokensMatch[2],
      10,
    );
    const contextLimit = Number.parseInt(anthropicMaxTokensMatch[3], 10);
    return {
      maxInputTokens: Math.max(contextLimit - reservedOutputTokens, 1),
      requestedTokens: inputTokens,
    };
  }

  return null;
}

/**
 * Trim messages to fit within a token limit.
 * Drop order: middle exchanges (oldest first) → system → the user request
 * the newest tool round serves, unless shrinking that round makes room for
 * it → the newest exchange's oversized content. A message goes together with the tool results
 * after it, so a trimmed history never splits a tool call from its results,
 * and it still opens with a user turn.
 *
 * `systemPrompt` is sent to the provider separately (not part of `messages`)
 * but still counts against the input limit, so its budget is reserved here.
 */
export function trimMessagesToTokenLimit(params: {
  messages: ModelMessage[];
  maxTokens: number;
  systemPrompt?: string;
  /** Provider-reported token count of the rejected request (see ContextLengthError). */
  requestedTokens?: number;
}): ModelMessage[] {
  const { messages, maxTokens, systemPrompt, requestedTokens } = params;
  const systemPromptChars = systemPrompt?.length ?? 0;
  const chars = estimateModelMessageChars;
  let total = messages.reduce((s, m) => s + chars(m), 0);

  // Token-dense payloads (large JSON tool results) can run near 2 chars/token,
  // so a budget built on the 4-chars/token default can exceed the payload and
  // trim nothing. When the provider reported the rejected request's token
  // count, derive the payload's real ratio instead, with headroom because the
  // retry only gets one attempt (and non-message tokens like tool definitions
  // count against the limit but not against this char total).
  const charsPerToken =
    requestedTokens && requestedTokens > 0
      ? ((total + systemPromptChars) / requestedTokens) *
        CONTEXT_TRIM_HEADROOM_RATIO
      : CHARS_PER_TOKEN;
  const charBudget = Math.max(maxTokens * charsPerToken - systemPromptChars, 0);
  if (total <= charBudget || messages.length === 0) return messages;
  const trimBudget = charBudget - TRIM_NOTICE.length;

  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  // The newest exchange: the last non-tool message and the tool results after it.
  const tailStart = Math.max(
    nonSystem.findLastIndex((m) => m.role !== "tool"),
    0,
  );
  let tail: ModelMessage[] = nonSystem.slice(tailStart);
  // Mid-turn the newest exchange is a tool round; the user request it serves
  // is dropped only after every other middle exchange.
  const requestIndex = tail.some((m) => m.role === "user")
    ? -1
    : nonSystem.slice(0, tailStart).findLastIndex((m) => m.role === "user");
  const before = nonSystem.slice(0, Math.max(requestIndex, 0));
  const request = requestIndex >= 0 ? [nonSystem[requestIndex]] : [];
  const after = nonSystem.slice(requestIndex + 1, tailStart);

  // 1. Drop middle exchanges from oldest
  for (const exchanges of [before, after]) {
    while (total > trimBudget && exchanges.length > 0) {
      do {
        const dropped = exchanges.shift();
        if (dropped) total -= chars(dropped);
      } while (exchanges[0]?.role === "tool");
    }
  }

  // 2. Drop system messages from oldest
  while (total > trimBudget && system.length > 0) {
    const dropped = system.shift();
    if (dropped) total -= chars(dropped);
  }

  // 3. Drop the request only when shrinking the round it serves cannot make
  // room for it.
  const tailChars = tail.reduce((s, m) => s + chars(m), 0);
  const [requestMessage] = request;
  if (
    total > trimBudget &&
    requestMessage &&
    (tail.length === 1 ||
      perResultAllowance(tail, trimBudget - (total - tailChars)) <
        MIN_SHRUNK_TOOL_RESULT_CHARS)
  ) {
    request.length = 0;
    total -= chars(requestMessage);
  }

  // 4. The newest exchange is still over budget: shrink its tool results, or
  // cut a lone message down to its text.
  if (total > trimBudget) {
    const charsForTail = trimBudget - (total - tailChars);
    tail =
      tail.length > 1
        ? shrinkToolResults(tail, charsForTail)
        : truncateLastMessage(tail[0], charsForTail);
  }

  const kept = dropUnpairedToolParts({
    kept: [...before, ...request, ...after, ...tail],
    original: nonSystem,
  });
  // Bedrock and Gemini reject a history that opens with an assistant turn, so
  // the notice becomes the opening user turn when one is needed.
  const notice = {
    role: kept[0]?.role === "user" ? "system" : "user",
    content: TRIM_NOTICE,
  } as ModelMessage;
  return [...system, notice, ...kept];
}

/**
 * Message size in characters, with attachments counted at their estimated
 * token cost rather than their serialized bytes: an inline image is megabytes
 * of base64 but at most ~1.6k tokens.
 */
export function estimateModelMessageChars(message: ModelMessage): number {
  if (typeof message.content === "string") return message.content.length;
  return message.content.reduce((sum, part) => {
    switch (part.type) {
      case "image":
        return (
          sum +
          estimateFileTokens({
            mediaType: part.mediaType ?? "image/*",
            byteLength: dataByteLength(part.image),
          }) *
            CHARS_PER_TOKEN
        );
      case "file":
        return (
          sum +
          estimateFileTokens({
            mediaType: part.mediaType,
            byteLength: dataByteLength(part.data),
          }) *
            CHARS_PER_TOKEN
        );
      default:
        return sum + JSON.stringify(part).length;
    }
  }, 0);
}

/**
 * Replace tool-result outputs whose serialized size exceeds `maxBytes` with a
 * truncated text rendering plus a notice. The part keeps its toolCallId, so
 * tool-call/tool-result pairing stays intact for provider validation.
 */
export function capToolResultOutputs(
  messages: ModelMessage[],
  maxBytes: number,
): ModelMessage[] {
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      // Budget text by its own length: JSON escaping would push a result the
      // chat tools already capped back over the limit and cut its tail.
      const serialized =
        part.output.type === "text"
          ? part.output.value
          : JSON.stringify(part.output);
      const size = utf8Length(serialized);
      if (size <= maxBytes) return part;
      messageChanged = true;
      return {
        ...part,
        output: {
          // A failed call stays a failure on the wire (e.g. Anthropic is_error).
          type: isErrorOutput(part.output.type)
            ? ("error-text" as const)
            : ("text" as const),
          value: `${sliceUtf8(serialized, maxBytes)}\n[tool result truncated: ${size} bytes exceeded the ${maxBytes}-byte limit for model context]`,
        },
      };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content } as ModelMessage;
  });
  return changed ? result : messages;
}

// =============================================================================
// INTERNAL
// =============================================================================

/**
 * Keep the user's request: its text survives, sliced if it alone overflows;
 * image/file/tool-result parts that can't be sliced into valid parts are
 * dropped. A message with no text (e.g. a bare tool result) is dropped rather
 * than sent malformed.
 */
function truncateLastMessage(
  last: ModelMessage | undefined,
  maxChars: number,
): ModelMessage[] {
  if (!last) return [];
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content
          .filter(
            (part): part is { type: "text"; text: string } =>
              part.type === "text",
          )
          .map((part) => part.text)
          .join("\n");
  const keep = Math.max(Math.min(text.length, maxChars), 0);
  return keep === 0
    ? []
    : [{ role: last.role, content: text.slice(0, keep) } as ModelMessage];
}

/** Shrink the newest exchange's tool results evenly so it fits `maxChars`. */
function shrinkToolResults(
  tail: ModelMessage[],
  maxChars: number,
): ModelMessage[] {
  return capToolResultOutputs(
    tail,
    Math.max(perResultAllowance(tail, maxChars), 0),
  );
}

/** Characters each of the round's tool results may keep within `maxChars`. */
function perResultAllowance(tail: ModelMessage[], maxChars: number): number {
  const results = tail.flatMap((m) =>
    m.role === "tool" && Array.isArray(m.content)
      ? m.content.filter((part) => part.type === "tool-result")
      : [],
  );
  const otherChars = tail
    .filter((m) => m.role !== "tool")
    .reduce((s, m) => s + estimateModelMessageChars(m), 0);
  return Math.floor(
    (maxChars - otherChars) / Math.max(results.length, 1) -
      TOOL_RESULT_ENVELOPE_CHARS,
  );
}

/**
 * Providers reject a tool result without its call and, on most hosts, a call
 * without its result. Drop the parts whose counterpart trimming removed (and
 * messages left empty). A call that had no result before trimming, e.g. one
 * awaiting approval, stays.
 */
function dropUnpairedToolParts(params: {
  kept: ModelMessage[];
  original: ModelMessage[];
}): ModelMessage[] {
  const originalResults = toolPartIds(params.original, "tool-result");
  const keptResults = toolPartIds(params.kept, "tool-result");
  const keptCalls = toolPartIds(params.kept, "tool-call");
  return params.kept.flatMap((message): ModelMessage[] => {
    if (typeof message.content === "string") return [message];
    const content = (message.content as ToolPairPart[]).filter(
      ({ type, toolCallId }) => {
        if (toolCallId === undefined) return true;
        if (type === "tool-call")
          return (
            keptResults.has(toolCallId) || !originalResults.has(toolCallId)
          );
        if (type === "tool-result") return keptCalls.has(toolCallId);
        return true;
      },
    );
    if (content.length === message.content.length) return [message];
    return content.length === 0
      ? []
      : [{ ...message, content } as ModelMessage];
  });
}

function toolPartIds(
  messages: ModelMessage[],
  type: "tool-call" | "tool-result",
): Set<string> {
  return new Set(
    messages.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : (message.content as ToolPairPart[]).flatMap((part) =>
            part.type === type && part.toolCallId !== undefined
              ? [part.toolCallId]
              : [],
          ),
    ),
  );
}

type ToolPairPart = { type: string; toolCallId?: string };

function dataByteLength(data: DataContent | URL): number {
  if (data instanceof URL) return 0;
  if (typeof data === "string") return Math.ceil((data.length * 3) / 4);
  return data.byteLength;
}

function isErrorOutput(type: string): boolean {
  return type === "error-text" || type === "error-json";
}

const TRIM_NOTICE =
  "[Earlier context was trimmed to fit the model's context window.]";

// What a tool-result part adds around its output text when serialized.
const TOOL_RESULT_ENVELOPE_CHARS = 200;
/** Below this, a shrunk result says too little to be worth its request. */
const MIN_SHRUNK_TOOL_RESULT_CHARS = 500;
