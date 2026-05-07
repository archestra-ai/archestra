import { describe, expect, it } from "vitest";
import { addNomicTaskPrefix } from "./knowledge-base";

describe("addNomicTaskPrefix", () => {
  it("adds search_document prefix for nomic models", () => {
    expect(
      addNomicTaskPrefix("nomic-embed-text", "hello world", "search_document"),
    ).toBe("search_document: hello world");
  });

  it("adds search_query prefix for nomic models", () => {
    expect(
      addNomicTaskPrefix("nomic-embed-text", "hello world", "search_query"),
    ).toBe("search_query: hello world");
  });

  it("works with nomic model variants", () => {
    expect(
      addNomicTaskPrefix(
        "nomic-embed-text-v1.5",
        "some text",
        "search_document",
      ),
    ).toBe("search_document: some text");
  });

  it("works with OpenRouter-prefixed nomic models", () => {
    expect(
      addNomicTaskPrefix(
        "nomic-ai/nomic-embed-text",
        "some text",
        "search_query",
      ),
    ).toBe("search_query: some text");
  });

  it("returns text unchanged for non-nomic models", () => {
    expect(
      addNomicTaskPrefix(
        "text-embedding-3-small",
        "hello world",
        "search_document",
      ),
    ).toBe("hello world");
  });

  it("returns text unchanged for text-embedding-3-large", () => {
    expect(
      addNomicTaskPrefix(
        "text-embedding-3-large",
        "hello world",
        "search_query",
      ),
    ).toBe("hello world");
  });
});
