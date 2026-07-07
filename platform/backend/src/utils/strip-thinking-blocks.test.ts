import { describe, expect, it } from "vitest";
import { stripThinkingBlocks } from "./strip-thinking-blocks";

describe("stripThinkingBlocks", () => {
  it("removes a block and keeps the surrounding text", () => {
    expect(stripThinkingBlocks("a<thinking>b</thinking>c")).toBe("ac");
  });

  it("removes multiple independent blocks without eating content between them", () => {
    expect(
      stripThinkingBlocks(
        "keep1<thinking>x</thinking>keep2<thinking>y</thinking>keep3",
      ),
    ).toBe("keep1keep2keep3");
  });

  it("matches the tag case-insensitively", () => {
    expect(stripThinkingBlocks("a<THINKING>b</Thinking>c")).toBe("ac");
  });

  it("strips a multiline block", () => {
    expect(stripThinkingBlocks("a<thinking>line1\nline2</thinking>b")).toBe(
      "ab",
    );
  });

  it("trims the result and returns empty when only a block remains", () => {
    expect(stripThinkingBlocks("  <thinking>all</thinking>  ")).toBe("");
  });

  it("leaves text without blocks unchanged except for trimming", () => {
    expect(stripThinkingBlocks("plain answer")).toBe("plain answer");
  });

  it("removes a `<think>` block (Qwen-style spelling)", () => {
    expect(stripThinkingBlocks("a<think>b</think>c")).toBe("ac");
  });

  it("strips a multiline `<think>` block", () => {
    expect(stripThinkingBlocks("a<think>line1\nline2</think>b")).toBe("ab");
  });

  it("matches the `<think>` tag case-insensitively", () => {
    expect(stripThinkingBlocks("a<THINK>b</Think>c")).toBe("ac");
  });

  it("strips a mix of `<think>` and `<thinking>` blocks", () => {
    expect(
      stripThinkingBlocks(
        "keep1<think>x</think>keep2<thinking>y</thinking>keep3",
      ),
    ).toBe("keep1keep2keep3");
  });

  it("returns empty when only a `<think>` block remains", () => {
    expect(stripThinkingBlocks("  <think>all</think>  ")).toBe("");
  });
});
