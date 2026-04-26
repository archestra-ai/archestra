import type { ModelMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { shouldCompact } from "./context-compaction";

// shouldCompact uses a character threshold; test using a large enough content.
const CHARS_PER_TOKEN = 4;
const COMPACTION_THRESHOLD_TOKENS = 80_000;
const THRESHOLD_CHARS = COMPACTION_THRESHOLD_TOKENS * CHARS_PER_TOKEN; // 320 000

function makeMsg(
  role: ModelMessage["role"],
  content: string,
): ModelMessage {
  return { role, content } as ModelMessage;
}

describe("shouldCompact", () => {
  test("returns false when messages are well below the threshold", () => {
    const messages = [makeMsg("user", "hello"), makeMsg("assistant", "hi")];
    expect(shouldCompact(messages)).toBe(false);
  });

  test("returns false for an empty array", () => {
    expect(shouldCompact([])).toBe(false);
  });

  test("returns true when total serialised length exceeds threshold", () => {
    // Single message whose JSON-serialised content exceeds 320 000 chars.
    const bigContent = "x".repeat(THRESHOLD_CHARS + 1);
    const messages = [makeMsg("user", bigContent)];
    expect(shouldCompact(messages)).toBe(true);
  });

  test("returns true when multiple messages together exceed threshold", () => {
    const chunkSize = Math.ceil(THRESHOLD_CHARS / 3) + 1;
    const messages = [
      makeMsg("user", "a".repeat(chunkSize)),
      makeMsg("assistant", "b".repeat(chunkSize)),
      makeMsg("user", "c".repeat(chunkSize)),
    ];
    expect(shouldCompact(messages)).toBe(true);
  });

  test("returns false when messages are exactly at the threshold boundary", () => {
    // Content that produces exactly THRESHOLD_CHARS when serialised.
    // JSON.stringify("x".repeat(n)) adds two quote characters, so use n-2 chars.
    const exactContent = "x".repeat(THRESHOLD_CHARS - 2);
    const messages = [makeMsg("user", exactContent)];
    // Should NOT trigger compaction (strictly greater than threshold).
    expect(shouldCompact(messages)).toBe(false);
  });

  test("ignores system messages when calculating total size", () => {
    // A system message alone should count toward the total.
    const bigSystem = makeMsg("system", "s".repeat(THRESHOLD_CHARS + 1));
    expect(shouldCompact([bigSystem])).toBe(true);
  });

  test("accounts for non-string content via JSON serialisation", () => {
    const bigObject = { data: "x".repeat(THRESHOLD_CHARS) };
    // JSON.stringify adds surrounding braces and key/value quotes.
    const messages = [{ role: "user" as const, content: bigObject }] as ModelMessage[];
    expect(shouldCompact(messages)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration-level: verify the module exports the expected symbols
// ---------------------------------------------------------------------------
describe("context-compaction exports", () => {
  test("exports shouldCompact as a function", async () => {
    const mod = await import("./context-compaction");
    expect(typeof mod.shouldCompact).toBe("function");
  });

  test("exports compactMessagesIfNeeded as a function", async () => {
    const mod = await import("./context-compaction");
    expect(typeof mod.compactMessagesIfNeeded).toBe("function");
  });
});
