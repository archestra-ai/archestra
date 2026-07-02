/**
 * Shared chatops utility functions.
 */

import type { SkippedAttachment } from "@/types/chatops";

/**
 * Build the in-context note telling the model that files were attached but not
 * delivered, and why. Without this the model sees no trace of the file and
 * confidently tells the user "no file came through". Returns "" when nothing
 * was skipped so callers can append unconditionally.
 */
export function buildSkippedAttachmentsNote(
  skipped: SkippedAttachment[],
): string {
  if (skipped.length === 0) return "";
  const items = skipped
    .map((s) => {
      const name = s.name ? `"${s.name}"` : "an unnamed file";
      const size =
        s.sizeBytes !== undefined ? ` (${formatByteSize(s.sizeBytes)})` : "";
      return `${name}${size} — ${SKIPPED_REASON_TEXT[s.reason]}`;
    })
    .join("; ");
  const count =
    skipped.length === 1 ? "1 file was" : `${skipped.length} files were`;
  return `\n\n[Note: ${count} attached to this message but could not be shown to you: ${items}. If the user refers to such a file, explain it could not be included (e.g. it was too large) rather than saying you see nothing.]`;
}

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

// ===========================================================================
// Internal helpers
// ===========================================================================

/**
 * Human-readable byte size (e.g. "15.8 MB", "107 KB"), matching the units the
 * provider UIs show. Binary (1024) so it lines up with Slack's file labels.
 */
function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

const SKIPPED_REASON_TEXT: Record<SkippedAttachment["reason"], string> = {
  too_large: "too large",
  download_failed: "could not be downloaded",
  total_limit_reached: "skipped (total attachment size limit reached)",
  too_many: "skipped (too many files attached)",
};
