/**
 * Workaround for LiteLLM/vLLM context length errors.
 * When these proxies return a 400 with "maximum input length of N tokens",
 * we parse the limit, trim messages, and retry the request.
 */
import { APICallError, type ModelMessage } from "ai";

const CHARS_PER_TOKEN = 4;

/**
 * Parse max input token limit from vLLM/LiteLLM error responses.
 * Matches:
 * - vLLM: "maximum input length of 8192 tokens"
 * - LiteLLM: "Max Input Tokens=200000"
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

  const match =
    body.match(/maximum input length of (\d+)/) ??
    body.match(/Max Input Tokens=(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Estimate token count from a ModelMessage array using character count heuristic.
 */
export function estimateTokenCount(messages: ModelMessage[]): number {
  const totalChars = messages.reduce(
    (sum, m) => sum + JSON.stringify(m.content).length,
    0,
  );
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

/**
 * Trim messages to fit within a token limit.
 * Drop order: middle messages (oldest first) → system → last message.
 */
export function trimMessagesToTokenLimit(
  messages: ModelMessage[],
  maxTokens: number,
): ModelMessage[] {
  const charBudget = maxTokens * CHARS_PER_TOKEN;
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

  // 3. Truncate last message if still over budget
  let trimmedLast: ModelMessage | undefined = last;
  if (last && total > charBudget) {
    const lastStr = JSON.stringify(last.content);
    const excess = total - charBudget;
    trimmedLast = {
      role: last.role,
      content: lastStr.slice(0, Math.max(lastStr.length - excess, 0)),
    } as ModelMessage;
  }

  const result: ModelMessage[] = [...system, ...middle, trimmedLast];

  if (result.length < messages.length || trimmedLast !== last) {
    result.unshift({
      role: "system",
      content:
        "[Earlier context was trimmed to fit the model's context window.]",
    });
  }

  return result;
}
