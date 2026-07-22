import { describe, expect, it } from "vitest";
import { hasThinkingTags, parseThinkingTags } from "./parse-thinking";

describe("parseThinkingTags", () => {
  it("should return original text when no think tags present", () => {
    const text = "This is a regular response without any thinking.";
    const result = parseThinkingTags(text);

    expect(result).toEqual([{ type: "text", text }]);
  });

  it("should parse single think block", () => {
    const text =
      "<think>I need to figure out what the user wants.</think>Here is my response.";
    const result = parseThinkingTags(text);

    expect(result).toEqual([
      { type: "reasoning", text: "I need to figure out what the user wants." },
      { type: "text", text: "Here is my response." },
    ]);
  });

  it("should handle think block at the end", () => {
    const text = "Here is my response.<think>That was a good answer.</think>";
    const result = parseThinkingTags(text);

    expect(result).toEqual([
      { type: "text", text: "Here is my response." },
      { type: "reasoning", text: "That was a good answer." },
    ]);
  });

  it("should parse multiple think blocks", () => {
    const text =
      "<think>First thought</think>Some text<think>Second thought</think>More text";
    const result = parseThinkingTags(text);

    expect(result).toEqual([
      { type: "reasoning", text: "First thought" },
      { type: "text", text: "Some text" },
      { type: "reasoning", text: "Second thought" },
      { type: "text", text: "More text" },
    ]);
  });

  it("should handle multiline content in think blocks", () => {
    const text = `<think>
This is a multiline
thinking block
with several lines
</think>And here is the response.`;
    const result = parseThinkingTags(text);

    expect(result).toEqual([
      {
        type: "reasoning",
        text: "This is a multiline\nthinking block\nwith several lines",
      },
      { type: "text", text: "And here is the response." },
    ]);
  });

  it("should be case-insensitive", () => {
    const text = "<THINK>Uppercase tags</THINK>Response";
    const result = parseThinkingTags(text);

    expect(result).toEqual([
      { type: "reasoning", text: "Uppercase tags" },
      { type: "text", text: "Response" },
    ]);
  });

  it("should handle empty content", () => {
    const text = "";
    const result = parseThinkingTags(text);

    expect(result).toEqual([]);
  });

  it("should handle only think block with no other text", () => {
    const text = "<think>Just thinking, no output</think>";
    const result = parseThinkingTags(text);

    expect(result).toEqual([
      { type: "reasoning", text: "Just thinking, no output" },
    ]);
  });

  it("should skip empty think blocks", () => {
    const text = "<think></think>Actual content";
    const result = parseThinkingTags(text);

    expect(result).toEqual([{ type: "text", text: "Actual content" }]);
  });

  it("should handle whitespace-only sections", () => {
    const text = "   <think>Thinking</think>   ";
    const result = parseThinkingTags(text);

    expect(result).toEqual([{ type: "reasoning", text: "Thinking" }]);
  });
});

describe("hasThinkingTags", () => {
  it("should return true when think tags present", () => {
    expect(hasThinkingTags("<think>content</think>")).toBe(true);
    expect(hasThinkingTags("Before <think>content</think> after")).toBe(true);
  });

  it("should return false when no think tags", () => {
    expect(hasThinkingTags("No thinking here")).toBe(false);
    expect(hasThinkingTags("")).toBe(false);
  });

  it("should be case-insensitive", () => {
    expect(hasThinkingTags("<THINK>content</THINK>")).toBe(true);
    expect(hasThinkingTags("<Think>content</Think>")).toBe(true);
  });

  it("should match partial tags", () => {
    // This is intentional - we just check for tag presence
    expect(hasThinkingTags("Incomplete <think>")).toBe(true);
  });

  it("should match a closing tag with no opening tag", () => {
    // Ollama prefills the opening <think> when asked to suppress thinking, so a
    // model that reasons anyway emits only the closer. Testing for "<think>"
    // alone let the whole reasoning block render as the assistant's answer.
    expect(hasThinkingTags("Reasoning...</think>\n\nAnswer")).toBe(true);
  });
});

describe("parseThinkingTags with an unpaired closing tag", () => {
  // Reproduced against Ollama 0.32.0: qwen3:4b with `think: false` returns its
  // whole chain of thought as `content`, terminated by a bare </think>, then the
  // real answer.
  it("splits reasoning from the answer at the stray closer", () => {
    const result = parseThinkingTags(
      'Okay, the user said "hi". I should greet them.\n</think>\n\nHello! How can I assist you today?',
    );

    expect(result).toEqual([
      {
        type: "reasoning",
        text: 'Okay, the user said "hi". I should greet them.',
      },
      { type: "text", text: "Hello! How can I assist you today?" },
    ]);
  });

  it("treats the whole text as reasoning when nothing follows the closer", () => {
    expect(parseThinkingTags("Still reasoning</think>")).toEqual([
      { type: "reasoning", text: "Still reasoning" },
    ]);
  });

  it("leaves a properly paired block to the normal parser", () => {
    expect(parseThinkingTags("<think>Reasoning</think>Answer")).toEqual([
      { type: "reasoning", text: "Reasoning" },
      { type: "text", text: "Answer" },
    ]);
  });
});
