/**
 * Workaround for provider context length errors.
 * When a provider/gateway returns a 400 describing the context limit
 * (vLLM/LiteLLM "maximum input length of N tokens", OpenRouter-style
 * "maximum context length is N tokens"), we parse the limit, trim
 * messages, and retry the request.
 */
import type { SupportedProvider } from "@archestra/shared";
import { APICallError, type ModelMessage } from "ai";
import { TOKEN_ESTIMATE } from "./normalization/estimate-message-tokens";

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

  return null;
}

/**
 * Trim messages to fit within a token limit.
 * Drop order: middle messages (oldest first) → system → last message.
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
  const chars = (m: ModelMessage) => JSON.stringify(m.content).length;
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

  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  const last = nonSystem[nonSystem.length - 1];
  const middle = nonSystem.slice(0, -1);

  // 1. Drop middle messages from oldest
  while (total > charBudget && middle.length > 0) {
    const dropped = middle.shift();
    if (dropped) total -= chars(dropped);
  }

  // 2. Drop system messages from oldest
  while (total > charBudget && system.length > 0) {
    const dropped = system.shift();
    if (dropped) total -= chars(dropped);
  }

  // 3. The last message is still over budget. Keep its text so the user's
  // actual request survives the retry; drop image/file/tool-result parts that
  // can't be sliced into valid parts the provider would accept. Slice the
  // surviving text if it alone still overflows. A message with no text (e.g. a
  // bare tool result) is dropped rather than sent malformed.
  let trimmedLast: ModelMessage | undefined = last;
  if (last && total > charBudget) {
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

    const charsForLast = charBudget - (total - chars(last));
    const keep = Math.max(Math.min(text.length, charsForLast), 0);
    trimmedLast =
      keep === 0
        ? undefined
        : ({ role: last.role, content: text.slice(0, keep) } as ModelMessage);
  }

  const result: ModelMessage[] = dropOrphanedToolResults([
    ...system,
    ...middle,
    ...(trimmedLast ? [trimmedLast] : []),
  ]);

  if (result.length < messages.length || trimmedLast !== last) {
    result.unshift({
      role: "system",
      content:
        "[Earlier context was trimmed to fit the model's context window.]",
    });
  }

  return result;
}

// =============================================================================
// INTERNAL
// =============================================================================

/**
 * Dropping a middle assistant message can orphan the tool message carrying its
 * tool results; providers reject a tool result without the matching tool call,
 * which would make the trimmed retry fail on a validation error instead of the
 * context limit. Drop orphaned tool-result parts (and tool messages left
 * empty) so the trimmed payload stays valid.
 */
function dropOrphanedToolResults(messages: ModelMessage[]): ModelMessage[] {
  const toolCallIds = new Set<string>();
  const result: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "tool-call") toolCallIds.add(part.toolCallId);
      }
      result.push(message);
      continue;
    }
    if (message.role === "tool" && Array.isArray(message.content)) {
      const content = message.content.filter(
        (part) =>
          part.type !== "tool-result" || toolCallIds.has(part.toolCallId),
      );
      if (content.length === 0) continue;
      result.push(
        content.length === message.content.length
          ? message
          : ({ ...message, content } as ModelMessage),
      );
      continue;
    }
    result.push(message);
  }
  return result;
}
