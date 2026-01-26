import { describe, expect, it, vi } from "vitest";

// Mock the ai module before importing routes.chat
const mockGenerateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: mockGenerateText,
  };
});

// Mock createDirectLLMModel to avoid actual API calls
vi.mock("@/clients/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/llm-client")>();
  return {
    ...actual,
    createDirectLLMModel: vi.fn(() => "mocked-model"),
  };
});

import {
  buildTitlePrompt,
  extractFirstMessages,
  generateConversationTitle,
} from "./routes.chat";

describe("extractFirstMessages", () => {
  it("extracts first user message from parts", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "text", text: "Hello, how are you?" }],
      },
    ];

    const result = extractFirstMessages(messages);

    expect(result.firstUserMessage).toBe("Hello, how are you?");
    expect(result.firstAssistantMessage).toBe("");
  });

  it("extracts first assistant message from parts", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "Hi there! How can I help you?" }],
      },
    ];

    const result = extractFirstMessages(messages);

    expect(result.firstUserMessage).toBe("Hello");
    expect(result.firstAssistantMessage).toBe("Hi there! How can I help you?");
  });

  it("returns empty strings for empty messages array", () => {
    const result = extractFirstMessages([]);

    expect(result.firstUserMessage).toBe("");
    expect(result.firstAssistantMessage).toBe("");
  });

  it("skips messages without text parts", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "image", url: "https://example.com/image.png" }],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "Look at this image" }],
      },
    ];

    const result = extractFirstMessages(messages);

    expect(result.firstUserMessage).toBe("Look at this image");
  });

  it("only extracts first message of each role", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "text", text: "First user message" }],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "First assistant message" }],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "Second user message" }],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "Second assistant message" }],
      },
    ];

    const result = extractFirstMessages(messages);

    expect(result.firstUserMessage).toBe("First user message");
    expect(result.firstAssistantMessage).toBe("First assistant message");
  });

  it("handles messages with multiple parts", () => {
    const messages = [
      {
        role: "user",
        parts: [
          { type: "image", url: "https://example.com/image.png" },
          { type: "text", text: "What is in this image?" },
        ],
      },
    ];

    const result = extractFirstMessages(messages);

    expect(result.firstUserMessage).toBe("What is in this image?");
  });

  it("skips tool call parts in assistant messages", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "text", text: "Search for something" }],
      },
      {
        role: "assistant",
        parts: [
          { type: "tool-invocation", toolName: "search", args: {} },
          { type: "text", text: "Here are the search results" },
        ],
      },
    ];

    const result = extractFirstMessages(messages);

    expect(result.firstAssistantMessage).toBe("Here are the search results");
  });

  it("handles messages without parts array", () => {
    const messages = [
      { role: "user" },
      {
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      },
    ];

    const result = extractFirstMessages(messages);

    expect(result.firstUserMessage).toBe("Hello");
  });

  it("handles parts without text property", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "text" }], // No text property
      },
      {
        role: "user",
        parts: [{ type: "text", text: "Actual message" }],
      },
    ];

    const result = extractFirstMessages(messages);

    expect(result.firstUserMessage).toBe("Actual message");
  });
});

describe("buildTitlePrompt", () => {
  it("builds prompt with user message only", () => {
    const prompt = buildTitlePrompt("How do I create a React component?", "");

    expect(prompt).toContain("User: How do I create a React component?");
    expect(prompt).not.toContain("Assistant:");
    expect(prompt).toContain("Generate a short, concise title");
    expect(prompt).toContain("3-6 words");
  });

  it("builds prompt with both user and assistant messages", () => {
    const prompt = buildTitlePrompt(
      "What is TypeScript?",
      "TypeScript is a typed superset of JavaScript.",
    );

    expect(prompt).toContain("User: What is TypeScript?");
    expect(prompt).toContain(
      "Assistant: TypeScript is a typed superset of JavaScript.",
    );
  });

  it("includes instructions for title format", () => {
    const prompt = buildTitlePrompt("Hello", "Hi there");

    expect(prompt).toContain("Respond with ONLY the title");
    expect(prompt).toContain("no quotes");
    expect(prompt).toContain("no explanation");
  });
});

describe("generateConversationTitle", () => {
  it("returns generated title on success", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "  Debug React Error  ",
    });

    const result = await generateConversationTitle({
      provider: "anthropic",
      apiKey: "test-key",
      firstUserMessage: "Help me debug this React error",
      firstAssistantMessage: "I can help with that.",
    });

    expect(result).toBe("Debug React Error");
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "mocked-model",
        prompt: expect.stringContaining("Help me debug this React error"),
      }),
    );
  });

  it("returns null when LLM call fails", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("API Error"));

    const result = await generateConversationTitle({
      provider: "anthropic",
      apiKey: "test-key",
      firstUserMessage: "Hello",
      firstAssistantMessage: "Hi there!",
    });

    expect(result).toBeNull();
  });

  it("trims whitespace from generated title", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "\n  Title With Whitespace  \n",
    });

    const result = await generateConversationTitle({
      provider: "openai",
      apiKey: "test-key",
      firstUserMessage: "Test",
      firstAssistantMessage: "",
    });

    expect(result).toBe("Title With Whitespace");
  });
});

describe("title generation integration", () => {
  it("extractFirstMessages and buildTitlePrompt work together", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "text", text: "Help me debug this error" }],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "I can help you debug that. What error are you seeing?",
          },
        ],
      },
    ];

    const { firstUserMessage, firstAssistantMessage } =
      extractFirstMessages(messages);
    const prompt = buildTitlePrompt(firstUserMessage, firstAssistantMessage);

    expect(prompt).toContain("User: Help me debug this error");
    expect(prompt).toContain(
      "Assistant: I can help you debug that. What error are you seeing?",
    );
  });
});
