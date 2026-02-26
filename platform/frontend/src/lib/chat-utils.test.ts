import { describe, expect, it } from "vitest";
import { getConversationDisplayTitle, preserveNewlines } from "./chat-utils";

const DEFAULT_SESSION_NAME = "New Chat Session";

describe("getConversationDisplayTitle", () => {
  it("returns the title if provided", () => {
    expect(getConversationDisplayTitle("My Chat Title", [])).toBe(
      "My Chat Title",
    );
  });

  it("returns the title even if messages exist", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "text", text: "Hello from message" }],
      },
    ];
    expect(getConversationDisplayTitle("Explicit Title", messages)).toBe(
      "Explicit Title",
    );
  });

  it("extracts text from first user message when no title", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "text", text: "What is the weather?" }],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "The weather is sunny" }],
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      "What is the weather?",
    );
  });

  it("skips assistant messages to find first user message", () => {
    const messages = [
      {
        role: "assistant",
        parts: [{ type: "text", text: "Welcome!" }],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "User question here" }],
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      "User question here",
    );
  });

  it("handles messages with multiple parts", () => {
    const messages = [
      {
        role: "user",
        parts: [
          { type: "image", url: "http://example.com/img.png" },
          { type: "text", text: "Describe this image" },
        ],
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      "Describe this image",
    );
  });

  it("returns default session name when no title and no messages", () => {
    expect(getConversationDisplayTitle(null, [])).toBe(DEFAULT_SESSION_NAME);
    expect(getConversationDisplayTitle(null, undefined)).toBe(
      DEFAULT_SESSION_NAME,
    );
    expect(getConversationDisplayTitle(null)).toBe(DEFAULT_SESSION_NAME);
  });

  it("returns default session name when messages have no text parts", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "image", url: "http://example.com/img.png" }],
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      DEFAULT_SESSION_NAME,
    );
  });

  it("returns default session name when user message has no parts", () => {
    const messages = [
      {
        role: "user",
        parts: [],
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      DEFAULT_SESSION_NAME,
    );
  });

  it("returns default session name when user message has undefined parts", () => {
    const messages = [
      {
        role: "user",
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      DEFAULT_SESSION_NAME,
    );
  });
});

describe("preserveNewlines", () => {
  it("returns empty string for empty input", () => {
    expect(preserveNewlines("")).toBe("");
  });

  it("returns the input as-is for falsy values", () => {
    expect(preserveNewlines("")).toBe("");
  });

  it("returns single-line text unchanged", () => {
    expect(preserveNewlines("Hello world")).toBe("Hello world");
  });

  it("appends two trailing spaces to preserve single newlines", () => {
    expect(preserveNewlines("line 1\nline 2")).toBe("line 1  \nline 2");
  });

  it("preserves multiple consecutive newlines as paragraph breaks", () => {
    expect(preserveNewlines("line 1\n\nline 2")).toBe("line 1  \n\nline 2");
  });

  it("handles three or more lines", () => {
    expect(preserveNewlines("line 1\nline 2\nline 3")).toBe(
      "line 1  \nline 2  \nline 3",
    );
  });

  it("does not add trailing spaces to the last line", () => {
    const result = preserveNewlines("line 1\nline 2");
    expect(result.endsWith("line 2")).toBe(true);
    expect(result.endsWith("line 2  ")).toBe(false);
  });

  it("does not double-add trailing spaces to lines already ending with two spaces", () => {
    expect(preserveNewlines("line 1  \nline 2")).toBe("line 1  \nline 2");
  });

  it("leaves empty lines unchanged (they create paragraph breaks in markdown)", () => {
    expect(preserveNewlines("line 1\n\nline 3")).toBe("line 1  \n\nline 3");
  });

  it("preserves text inside fenced code blocks with backticks", () => {
    const input = "before\n```\ncode line 1\ncode line 2\n```\nafter";
    const expected = "before  \n```\ncode line 1\ncode line 2\n```\nafter";
    expect(preserveNewlines(input)).toBe(expected);
  });

  it("preserves text inside fenced code blocks with tildes", () => {
    const input = "before\n~~~\ncode line 1\ncode line 2\n~~~\nafter";
    const expected = "before  \n~~~\ncode line 1\ncode line 2\n~~~\nafter";
    expect(preserveNewlines(input)).toBe(expected);
  });

  it("preserves text inside fenced code blocks with language specifier", () => {
    const input =
      "before\n```python\nprint('hello')\nprint('world')\n```\nafter";
    const expected =
      "before  \n```python\nprint('hello')\nprint('world')\n```\nafter";
    expect(preserveNewlines(input)).toBe(expected);
  });

  it("handles mixed content with code blocks and regular text", () => {
    const input = "line 1\nline 2\n```\ncode\n```\nline 3\nline 4";
    const expected = "line 1  \nline 2  \n```\ncode\n```\nline 3  \nline 4";
    expect(preserveNewlines(input)).toBe(expected);
  });

  it("handles text with trailing newline", () => {
    expect(preserveNewlines("line 1\nline 2\n")).toBe("line 1  \nline 2  \n");
  });

  it("handles text with only newlines", () => {
    expect(preserveNewlines("\n\n")).toBe("\n\n");
  });

  it("handles text with indented code block fences", () => {
    const input = "before\n  ```\n  code\n  ```\nafter";
    const expected = "before  \n  ```\n  code\n  ```\nafter";
    expect(preserveNewlines(input)).toBe(expected);
  });

  it("handles a single newline", () => {
    expect(preserveNewlines("\n")).toBe("\n");
  });

  it("handles multiple empty lines between text", () => {
    expect(preserveNewlines("a\n\n\nb")).toBe("a  \n\n\nb");
  });
});
