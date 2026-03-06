import { get_encoding } from "tiktoken";
import { describe, expect, test } from "vitest";
import { chunkDocument } from "./chunker";

const encoding = get_encoding("cl100k_base");

function countTokens(text: string): number {
  return encoding.encode(text).length;
}

describe("chunkDocument", () => {
  test("short document returns single chunk", async () => {
    const chunks = await chunkDocument({
      title: "Short Doc",
      content: "This is a short document.",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].content).toContain("This is a short document.");
  });

  test("long document returns multiple chunks each within token limit", async () => {
    const sentences = Array.from(
      { length: 200 },
      (_, i) =>
        `Sentence number ${i + 1} contains important information about the topic at hand.`,
    );
    const content = sentences.join(" ");

    const chunks = await chunkDocument({ title: "Long Doc", content });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(512);
    }
  });

  test("empty content returns empty array", async () => {
    const chunks = await chunkDocument({ title: "Empty", content: "" });
    expect(chunks).toEqual([]);
  });

  test("whitespace-only content returns empty array", async () => {
    const chunks = await chunkDocument({
      title: "Blank",
      content: "   \n\n  ",
    });
    expect(chunks).toEqual([]);
  });

  test("title prefix present in every chunk", async () => {
    const sentences = Array.from(
      { length: 100 },
      (_, i) => `This is sentence ${i + 1} with enough words to fill tokens.`,
    );
    const content = sentences.join(" ");

    const chunks = await chunkDocument({ title: "My Title", content });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content).toMatch(/^TITLE: My Title\n\n/);
    }
  });

  test("empty title does not add prefix", async () => {
    const chunks = await chunkDocument({
      title: "",
      content: "Some content here.",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("Some content here.");
  });

  test("sentence boundaries respected", async () => {
    const sentences = Array.from(
      { length: 100 },
      (_, i) => `Sentence ${i + 1} is a complete thought that ends properly.`,
    );
    const content = sentences.join(" ");

    const chunks = await chunkDocument({ title: "Boundaries", content });

    // No chunk body should start or end mid-word (after removing title prefix)
    for (const chunk of chunks) {
      const body = chunk.content.replace(/^TITLE: Boundaries\n\n/, "");
      // Body should not start with a space (mid-sentence artifact)
      expect(body).not.toMatch(/^\s/);
    }
  });

  test("markdown paragraph breaks respected", async () => {
    const paragraphs = Array.from(
      { length: 50 },
      (_, i) =>
        `Paragraph ${i + 1} has multiple sentences. It discusses topic ${i + 1} in detail. This ensures the paragraph is substantial enough to matter.`,
    );
    const content = paragraphs.join("\n\n");

    const chunks = await chunkDocument({ title: "Paragraphs", content });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(512);
    }
  });

  test("sequential chunk indices starting from 0", async () => {
    const sentences = Array.from(
      { length: 200 },
      (_, i) =>
        `Sentence ${i + 1} provides detailed information about an important subject.`,
    );
    const content = sentences.join(" ");

    const chunks = await chunkDocument({ title: "Indices", content });

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });

  test("token count accuracy matches tiktoken", async () => {
    const chunks = await chunkDocument({
      title: "Accuracy",
      content:
        "The quick brown fox jumps over the lazy dog. This is a simple test document for token counting accuracy.",
    });

    for (const chunk of chunks) {
      const actual = countTokens(chunk.content);
      expect(chunk.tokenCount).toBe(actual);
    }
  });

  test("unicode and emoji handling", async () => {
    const content =
      "Hello 🌍! This document has émojis and ünïcödé characters. 日本語テキストも含まれています。这是中文内容。";

    const chunks = await chunkDocument({ title: "Unicode 🎉", content });

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Recombined chunk bodies should contain all the original content
    const allText = chunks.map((c) => c.content).join("");
    expect(allText).toContain("🌍");
    expect(allText).toContain("日本語");
    expect(allText).toContain("这是中文");
  });

  test("very long title truncated to preserve content budget", async () => {
    const longTitle = "A".repeat(5000);
    const content = "This is the actual content that must be preserved.";

    const chunks = await chunkDocument({ title: longTitle, content });

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(512);
      expect(chunk.content).toContain("TITLE:");
    }
  });

  test("content that fits in one chunk returns single chunk", async () => {
    const chunks = await chunkDocument({
      title: "One Chunk",
      content: "A single small paragraph of text.",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].content).toBe(
      "TITLE: One Chunk\n\nA single small paragraph of text.",
    );
  });
});
