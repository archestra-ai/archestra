/**
 * Shared chatops utility functions.
 */

/**
 * In-memory dedup map for Slack events.
 *
 * Slack fires both `message` and `app_mention` events for @mentions with the
 * same `event.ts`. This map prevents duplicate processing within the same pod.
 * Entries auto-expire after `ttlMs` and the map bulk-evicts the oldest 10%
 * when it reaches `maxSize` as a safety bound.
 */
export class EventDedupMap {
  private readonly map = new Map<string, true>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 10_000, ttlMs = 30_000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /** Returns true if the key was already seen (duplicate). */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Mark a key as seen. Returns true if it was a duplicate. */
  mark(key: string): boolean {
    if (this.map.has(key)) return true;

    this.map.set(key, true);
    setTimeout(() => this.map.delete(key), this.ttlMs);

    if (this.map.size >= this.maxSize) {
      const toDelete = Math.ceil(this.maxSize * 0.1);
      const iter = this.map.keys();
      for (let i = 0; i < toDelete; i++) {
        const k = iter.next().value;
        if (k) this.map.delete(k);
      }
    }

    return false;
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Slack DM channel IDs start with "D".
 * @see https://api.slack.com/types/conversation
 */
export function isSlackDmChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

/**
 * Pretty-print a tool call's arguments for display inside an approval prompt.
 *
 * Returns a JSON string (truncated to keep the message within provider block
 * limits — Slack caps a single text block at ~3,000 chars) or `null` when there
 * is nothing meaningful to show (no args, or an empty object). Callers wrap the
 * result in their provider's native code-block formatting.
 */
export function formatApprovalToolArgs(
  args: Record<string, unknown> | undefined,
  maxLength = 2800,
): string | null {
  if (!args || Object.keys(args).length === 0) {
    return null;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(args, null, 2);
  } catch {
    return null;
  }
  if (serialized.length > maxLength) {
    return `${serialized.slice(0, maxLength)}\n… (truncated)`;
  }
  return serialized;
}

/**
 * Extract a human-readable error message from an unknown error value.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error (could not serialize)";
    }
  }
}
