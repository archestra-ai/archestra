import type { ModelMessage } from "ai";

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };

// Anthropic rejects a request with more than 4 `cache_control` breakpoints, and
// the @ai-sdk/anthropic provider throws before the call. Breakpoints already
// present (e.g. `materializeAttachments` marks each file/document part) count
// against this budget, so the markers added here must fit in what's left.
const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;

/**
 * Adds Anthropic `cache_control` breakpoints so the chat request's stable
 * prefix is prompt-cached across turns. Without a breakpoint Anthropic caches
 * nothing, re-billing the full system prompt + tool definitions + history on
 * every turn.
 *
 * A breakpoint caches everything rendered before it — Anthropic renders
 * `tools → system → messages` — so placing the markers on messages also caches
 * the system prompt and tools. Up to two breakpoints are added:
 *   - last message: a rolling breakpoint that extends the cached prefix to the
 *     most recent turn (each turn writes the new tail; the next turn reads it);
 *   - first message: the stable prefix (tools + system + first turn) that never
 *     changes, so it stays a cache hit on every later turn.
 *
 * Last is prioritized over first when only one slot is left in the breakpoint
 * budget. Messages that already carry a breakpoint (attachment parts) are left
 * alone — their prefix is already cacheable and re-marking would waste budget.
 *
 * No-op for providers other than Anthropic: OpenAI, Gemini, DeepSeek, etc.
 * cache prefixes automatically and reject or ignore explicit markers. (Bedrock
 * also supports caching but via `providerOptions.bedrock.cachePoint`, handled
 * separately.)
 */
export function applyPromptCacheBreakpoints(params: {
  provider: string;
  messages: ModelMessage[];
}): ModelMessage[] {
  const { provider, messages } = params;
  if (provider !== "anthropic" || messages.length === 0) {
    return messages;
  }

  const existingBreakpoints = messages.reduce(
    (total, message) => total + anthropicBreakpointCount(message),
    0,
  );
  let budget = MAX_ANTHROPIC_CACHE_BREAKPOINTS - existingBreakpoints;
  if (budget <= 0) {
    return messages;
  }

  const lastIndex = messages.length - 1;
  // Prefer the rolling (last) breakpoint, then the stable (first) one. A single
  // message collapses both candidates to index 0.
  const candidates = lastIndex === 0 ? [0] : [lastIndex, 0];

  const indicesToMark = new Set<number>();
  for (const index of candidates) {
    if (budget <= 0) break;
    // Already cacheable via its own marker — don't spend budget re-marking it.
    if (anthropicBreakpointCount(messages[index]) > 0) continue;
    indicesToMark.add(index);
    budget--;
  }

  if (indicesToMark.size === 0) {
    return messages;
  }

  return messages.map((message, index) =>
    indicesToMark.has(index) ? withAnthropicCacheControl(message) : message,
  );
}

// Counts `cache_control` breakpoints a message already contributes: one per
// content part that carries the marker, plus the message-level marker. May
// slightly over-count (a message-level marker only takes effect on the last
// part when that part has none), which is the safe direction — over-counting
// makes us add fewer breakpoints, never more than the cap allows.
function anthropicBreakpointCount(message: ModelMessage): number {
  let count = hasAnthropicCacheControl(message.providerOptions) ? 1 : 0;
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      // Not every content part type declares `providerOptions`; read it
      // structurally rather than narrowing the wide part union.
      const partProviderOptions = (part as { providerOptions?: unknown })
        .providerOptions;
      if (hasAnthropicCacheControl(partProviderOptions)) {
        count++;
      }
    }
  }
  return count;
}

function hasAnthropicCacheControl(providerOptions: unknown): boolean {
  return Boolean(
    (providerOptions as { anthropic?: { cacheControl?: unknown } } | undefined)
      ?.anthropic?.cacheControl,
  );
}

function withAnthropicCacheControl(message: ModelMessage): ModelMessage {
  const providerOptions = message.providerOptions ?? {};
  const anthropic = providerOptions.anthropic ?? {};
  return {
    ...message,
    providerOptions: {
      ...providerOptions,
      anthropic: { ...anthropic, cacheControl: EPHEMERAL_CACHE_CONTROL },
    },
  };
}
