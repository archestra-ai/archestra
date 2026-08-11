import { describe, expect, test } from "@/test";
import { countTokens, getEncoding, truncateToTokens } from "./tokenizer";

describe("truncateToTokens", () => {
  const encoding = getEncoding();

  test("returns text under the limit unchanged", () => {
    expect(truncateToTokens(encoding, "hello world", 100)).toBe("hello world");
  });

  test("truncates over-limit text to at most the token budget", () => {
    const text = "one two three four five six seven eight nine ten ".repeat(20);
    const truncated = truncateToTokens(encoding, text, 50);
    expect(truncated.length).toBeLessThan(text.length);
    expect(countTokens(encoding, truncated)).toBeLessThanOrEqual(50);
    expect(text.startsWith(truncated)).toBe(true);
  });

  test("never leaves a broken multi-byte character at the cut", () => {
    // Emoji and CJK are multi-byte and multi-token in cl100k; a token boundary
    // can fall mid-character. Every cut must still decode to valid text.
    const text = "🎉🎊🇺🇦🎈".repeat(50) + "汉字テスト".repeat(50);
    for (const limit of [1, 2, 3, 5, 10, 33]) {
      const truncated = truncateToTokens(encoding, text, limit);
      expect(truncated).not.toContain("�");
      expect(countTokens(encoding, truncated)).toBeLessThanOrEqual(limit);
    }
  });

  test("handles special-token literals in the text", () => {
    const text = `before <|endoftext|> after ${"filler ".repeat(100)}`;
    const truncated = truncateToTokens(encoding, text, 10);
    expect(countTokens(encoding, truncated)).toBeLessThanOrEqual(10);
  });

  test("returns an empty string for a non-positive budget", () => {
    expect(truncateToTokens(encoding, "hello", 0)).toBe("");
  });
});
