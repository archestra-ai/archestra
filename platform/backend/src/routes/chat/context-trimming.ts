/**
 * Workaround for LiteLLM/vLLM context length errors.
 * When these proxies return a 400 with "maximum input length of N tokens",
 * we parse the limit, trim messages, and retry the request.
 */
import type { SupportedProvider } from "@archestra/shared";
import { APICallError, type ModelMessage } from "ai";
import { TOKEN_ESTIMATE } from "./normalization/estimate-message-tokens";

const CHARS_PER_TOKEN = TOKEN_ESTIMATE.charsPerToken;

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

/**
 * Parse max input token limit from vLLM/LiteLLM error responses.
 * Matches: "maximum input length of 8192 tokens"
 */
export function parseMaxInputTokens(error: unknown): number | null {
  let body: string | undefined;

  if (APICallError.isInstance(error)) {
    body = (error as InstanceType<typeof APICallError>).responseBody;
  }
  if (!body) {
    body = error instanceof Error ? error.message : undefined;
  }
  if (!body) return null;

  const match = body.match(/maximum input length of (\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
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
}): ModelMessage[] {
  const { messages, maxTokens, systemPrompt } = params;
  const systemPromptChars = systemPrompt?.length ?? 0;
  const charBudget = Math.max(
    maxTokens * CHARS_PER_TOKEN - systemPromptChars,
    0,
  );
  const chars = (m: ModelMessage) => JSON.stringify(m.content).length;
  let total = messages.reduce((s, m) => s + chars(m), 0);
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

  const result: ModelMessage[] = [
    ...system,
    ...middle,
    ...(trimmedLast ? [trimmedLast] : []),
  ];

  if (result.length < messages.length || trimmedLast !== last) {
    result.unshift({
      role: "system",
      content:
        "[Earlier context was trimmed to fit the model's context window.]",
    });
  }

  return result;
}
