import { describe, expect, test } from "vitest";
import { chunkDocument } from "./chunker";
import { countTokens, getEncoding } from "./tokenizer";

const encoding = getEncoding();

function countTokensHelper(text: string): number {
  return countTokens(encoding, text);
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

  test("content quoting tokenizer special tokens chunks as plain text", async () => {
    // tiktoken's bare encode() THROWS on special-token literals; a real GitHub
    // issue quoting "<|endoftext|>" permanently failed ingestion this way.
    const chunks = await chunkDocument({
      title: "Discussing <|endoftext|> handling",
      content:
        "The model emits <|endoftext|> at the end of a completion. <|fim_prefix|> is another special token.",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("<|endoftext|>");
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
      const actual = countTokensHelper(chunk.content);
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

  test("no metadata returns null suffixes", async () => {
    const chunks = await chunkDocument({
      title: "No Meta",
      content: "Some content here.",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadataSuffixSemantic).toBeNull();
    expect(chunks[0].metadataSuffixKeyword).toBeNull();
  });

  test("empty metadata returns null suffixes", async () => {
    const chunks = await chunkDocument({
      title: "Empty Meta",
      content: "Some content here.",
      metadata: {},
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadataSuffixSemantic).toBeNull();
    expect(chunks[0].metadataSuffixKeyword).toBeNull();
  });

  test("metadata produces separate suffix fields", async () => {
    const chunks = await chunkDocument({
      title: "With Meta",
      content: "Some content here.",
      metadata: { status: "Open", priority: "High" },
    });

    expect(chunks).toHaveLength(1);
    // Content should NOT contain metadata
    expect(chunks[0].content).toBe("TITLE: With Meta\n\nSome content here.");
    // Suffixes should be separate
    expect(chunks[0].metadataSuffixSemantic).toContain("status - Open");
    expect(chunks[0].metadataSuffixSemantic).toContain("priority - High");
    expect(chunks[0].metadataSuffixKeyword).toContain("Open");
    expect(chunks[0].metadataSuffixKeyword).toContain("High");
  });

  test("metadata suffixes are identical across all chunks of a document", async () => {
    const sentences = Array.from(
      { length: 200 },
      (_, i) =>
        `Sentence number ${i + 1} contains important information about the topic at hand.`,
    );
    const content = sentences.join(" ");

    const chunks = await chunkDocument({
      title: "Multi Chunk",
      content,
      metadata: { type: "Bug" },
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.metadataSuffixSemantic).toBe(
        chunks[0].metadataSuffixSemantic,
      );
      expect(chunk.metadataSuffixKeyword).toBe(chunks[0].metadataSuffixKeyword);
    }
  });

  test("metadata reduces content budget so chunks stay within max tokens", async () => {
    const sentences = Array.from(
      { length: 200 },
      (_, i) =>
        `Sentence number ${i + 1} contains important information about the topic at hand.`,
    );
    const content = sentences.join(" ");

    const chunks = await chunkDocument({
      title: "Budget Test",
      content,
      metadata: { status: "In Progress", priority: "High", type: "Bug" },
    });

    for (const chunk of chunks) {
      // Content + semantic suffix should fit within MAX_TOKENS
      const fullText = chunk.content + (chunk.metadataSuffixSemantic ?? "");
      const tokens = countTokensHelper(fullText);
      expect(tokens).toBeLessThanOrEqual(512);
    }
  });

  test("chunk size is configurable and bounds the emitted chunks", async () => {
    // Same document, two budgets: the smaller budget must split it further.
    const content = Array.from(
      { length: 60 },
      (_, i) => `Sentence number ${i} describing part of a long document.`,
    ).join(" ");

    const wide = await chunkDocument({
      title: "Long Doc",
      content,
      maxTokens: 512,
    });
    const narrow = await chunkDocument({
      title: "Long Doc",
      content,
      maxTokens: 128,
    });

    expect(narrow.length).toBeGreaterThan(wide.length);
    for (const chunk of narrow) {
      expect(countTokensHelper(chunk.content)).toBeLessThanOrEqual(128);
    }
    for (const chunk of wide) {
      expect(countTokensHelper(chunk.content)).toBeLessThanOrEqual(512);
    }
  });
});

describe("chunkDocument parent/child indexing", () => {
  const LONG_DOCUMENT = Array.from(
    { length: 120 },
    (_, i) =>
      `Sentence number ${i + 1} contains important information about the topic at hand.`,
  ).join(" ");

  test("without a child size every chunk is its own passage", async () => {
    const chunks = await chunkDocument({
      title: "Runbook",
      content: LONG_DOCUMENT,
      maxTokens: 512,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.parentIndex === null)).toBe(true);
  });

  test("children partition their parent and are contiguous in chunk index", async () => {
    const parents = await chunkDocument({
      title: "Runbook",
      content: LONG_DOCUMENT,
      maxTokens: 512,
    });
    const children = await chunkDocument({
      title: "Runbook",
      content: LONG_DOCUMENT,
      maxTokens: 512,
      childMaxTokens: 128,
    });

    // Every child belongs to a passage, and the passages are exactly the
    // chunks the single pass produced — subdividing must not move a boundary.
    expect(children.every((chunk) => chunk.parentIndex !== null)).toBe(true);
    const parentIndexes = [...new Set(children.map((c) => c.parentIndex))];
    expect(parentIndexes).toEqual(parents.map((_, index) => index));

    expect(children.map((c) => c.chunkIndex)).toEqual(
      children.map((_, index) => index),
    );

    // Children of one parent occupy one unbroken run, so a passage is always a
    // contiguous span and never interleaves with another.
    for (const parentIndex of parentIndexes) {
      const indexes = children
        .filter((c) => c.parentIndex === parentIndex)
        .map((c) => c.chunkIndex);
      expect(indexes).toEqual(indexes.map((_, offset) => indexes[0] + offset));
    }
  });

  test("children are smaller than the passages they came from", async () => {
    const parents = await chunkDocument({
      title: "Runbook",
      content: LONG_DOCUMENT,
      maxTokens: 512,
    });
    const children = await chunkDocument({
      title: "Runbook",
      content: LONG_DOCUMENT,
      maxTokens: 512,
      childMaxTokens: 128,
    });

    expect(children.length).toBeGreaterThan(parents.length);
    for (const child of children) {
      expect(child.tokenCount).toBeLessThanOrEqual(128);
    }
  });

  test("a child budget no smaller than the parent's does not subdivide", async () => {
    // Otherwise every parent yields exactly one child: single-pass output that
    // has paid for a parent link and a sibling lookup on every search hit.
    const chunks = await chunkDocument({
      title: "Runbook",
      content: LONG_DOCUMENT,
      maxTokens: 512,
      childMaxTokens: 512,
    });

    expect(chunks.every((chunk) => chunk.parentIndex === null)).toBe(true);
  });

  test("every child carries the title prefix so it embeds standalone", async () => {
    const children = await chunkDocument({
      title: "Runbook",
      content: LONG_DOCUMENT,
      maxTokens: 512,
      childMaxTokens: 128,
    });

    expect(children.length).toBeGreaterThan(1);
    for (const child of children) {
      expect(child.content.startsWith("TITLE: Runbook\n\n")).toBe(true);
    }
  });

  test("a document too short to split still yields one child of one passage", async () => {
    const chunks = await chunkDocument({
      title: "Note",
      content: "The ingest service listens on port 8080.",
      maxTokens: 512,
      childMaxTokens: 128,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].parentIndex).toBe(0);
    expect(chunks[0].content).toContain("port 8080");
  });

  test("metadata that would dominate a child is dropped from its embedding but kept for keyword search", async () => {
    const metadata = {
      author: "Platform Team",
      project: "Ingest Pipeline Modernisation Programme",
      status: "Approved and scheduled for the next maintenance window",
      reviewers: ["Alpha Reviewer", "Beta Reviewer", "Gamma Reviewer"],
    };

    const parents = await chunkDocument({
      title: "Runbook",
      content: LONG_DOCUMENT,
      metadata,
      maxTokens: 512,
    });
    const children = await chunkDocument({
      title: "Runbook",
      content: LONG_DOCUMENT,
      metadata,
      maxTokens: 512,
      childMaxTokens: 64,
    });

    // At passage size the metadata is worth its room; on a chunk a fraction of
    // that size the same suffix would take most of the embedding, which is the
    // dilution small chunks exist to avoid.
    expect(parents[0].metadataSuffixSemantic).not.toBeNull();
    expect(children[0].metadataSuffixSemantic).toBeNull();

    // The keyword suffix is indexed into search_vector rather than embedded, so
    // it dilutes nothing and metadata stays findable by keyword.
    expect(children[0].metadataSuffixKeyword).toBe(
      parents[0].metadataSuffixKeyword,
    );
  });
});
