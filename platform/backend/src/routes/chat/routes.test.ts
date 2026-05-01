import { describe, expect, it, vi } from "vitest";

// Mock the ai module before importing chat routes
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

// Mock LlmProviderApiKeyModelLinkModel for fast model DB lookup
const mockGetFastestModel = vi.hoisted(() => vi.fn());
vi.mock("@/models/llm-provider-api-key-model", () => ({
  default: { getFastestModel: mockGetFastestModel },
}));

import { archestraMcpBranding } from "@/archestra-mcp-server";
import { createDirectLLMModel } from "@/clients/llm-client";
import {
  __test,
  buildChatStopConditions,
  buildTitlePrompt,
  extractFirstMessages,
  generateConversationTitle,
  getChatStopToolNames,
} from "./routes";

describe("prepareMessagesForProvider", () => {
  it("normalizes csv files to text/plain for anthropic", () => {
    const messages = __test.prepareMessagesForProvider({
      provider: "anthropic",
      messages: [
        {
          role: "user",
          parts: [
            {
              type: "file",
              mediaType: "text/csv",
              filename: "report.csv",
              url: "data:text/csv;base64,YSxiLGM=",
            },
          ],
        },
      ],
    });

    expect(messages[0].parts?.[0]).toMatchObject({
      type: "file",
      mediaType: "text/plain",
      filename: "report.csv",
      url: "data:text/plain;base64,YSxiLGM=",
    });
  });

  it("normalizes markdown files to text/plain for anthropic", () => {
    const messages = __test.prepareMessagesForProvider({
      provider: "anthropic",
      messages: [
        {
          role: "user",
          parts: [
            {
              type: "file",
              mediaType: "text/markdown",
              filename: "README.md",
              url: "data:text/markdown;base64,IyBUaXRsZQ==",
            },
          ],
        },
      ],
    });

    expect(messages[0].parts?.[0]).toMatchObject({
      type: "file",
      mediaType: "text/plain",
      filename: "README.md",
      url: "data:text/plain;base64,IyBUaXRsZQ==",
    });
  });

  it("leaves non-anthropic file parts unchanged", () => {
    const message = {
      role: "user" as const,
      parts: [
        {
          type: "file",
          mediaType: "text/csv",
          filename: "report.csv",
          url: "data:text/csv;base64,YSxiLGM=",
        },
      ],
    };

    const messages = __test.prepareMessagesForProvider({
      provider: "openai",
      messages: [message],
    });

    expect(messages[0]).toBe(message);
  });

  const pdfFilePart = {
    type: "file",
    mediaType: "application/pdf",
    filename: "report.pdf",
    url: "data:application/pdf;base64,JVBERi0=",
  };

  it("prepends placeholder text for bedrock user messages with only a file part", () => {
    const messages = __test.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [{ role: "user", parts: [pdfFilePart] }],
    });

    expect(messages[0].parts).toEqual([
      { type: "text", text: expect.stringMatching(/\S/) },
      pdfFilePart,
    ]);
  });

  it("prepends placeholder when the only existing text part is whitespace", () => {
    const messages = __test.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "   " }, pdfFilePart],
        },
      ],
    });

    expect(messages[0].parts?.[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/\S/),
    });
  });

  it("leaves bedrock user messages with text and file untouched", () => {
    const message = {
      role: "user" as const,
      parts: [{ type: "text", text: "Summarize this" }, pdfFilePart],
    };

    const messages = __test.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [message],
    });

    expect(messages[0]).toBe(message);
  });

  it("pads bedrock assistant messages whose only text part is whitespace", () => {
    const messages = __test.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [{ role: "assistant", parts: [{ type: "text", text: "" }] }],
    });

    expect(messages[0].parts).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/\S/),
      }),
    );
  });

  it("pads bedrock messages whose reasoning lacks a bedrock signature", () => {
    const messages = __test.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [
        {
          role: "assistant",
          parts: [{ type: "reasoning", text: "thinking..." }],
        },
      ],
    });

    expect(messages[0].parts).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/\S/),
      }),
    );
  });

  it("leaves bedrock assistant messages with a tool-call part untouched", () => {
    const message = {
      role: "assistant" as const,
      parts: [
        {
          type: "tool-call",
          toolCallId: "call_123",
          toolName: "search",
          input: { q: "x" },
        },
      ],
    };

    const messages = __test.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [message],
    });

    expect(messages[0]).toBe(message);
  });

  it("leaves bedrock messages with reasoning that carries a bedrock signature", () => {
    const message = {
      role: "assistant" as const,
      parts: [
        {
          type: "reasoning",
          text: "thinking...",
          providerOptions: { bedrock: { signature: "sig-abc" } },
        },
      ],
    };

    const messages = __test.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [message],
    });

    expect(messages[0]).toBe(message);
  });
});

describe("getMessagesNotYetPersisted", () => {
  it("keeps new messages even when the incoming thread is shorter than the persisted thread", () => {
    const newMessages = __test.getMessagesNotYetPersisted({
      existingMessages: [
        {
          id: "db-user-1",
          content: {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "draw something" }],
          },
        },
        {
          id: "db-assistant-1",
          content: {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-archestra__swap_agent",
                toolCallId: "swap-1",
                state: "output-available",
                output: { success: true },
              },
            ],
          },
        },
      ],
      uiMessages: [
        {
          id: "swap-poke-1",
          role: "user",
          parts: [
            {
              type: "text",
              text: "(Switched to Drawing agent. Please continue the conversation.)",
            },
          ],
        },
        {
          id: "assistant-2",
          role: "assistant",
          parts: [{ type: "text", text: "Hello! I am the child agent." }],
        },
      ],
    });

    expect(newMessages).toHaveLength(2);
    expect(newMessages.map((message) => message.id)).toEqual([
      "swap-poke-1",
      "assistant-2",
    ]);
  });

  it("does not re-persist messages whose temporary content ids were already saved with db uuids", () => {
    const newMessages = __test.getMessagesNotYetPersisted({
      existingMessages: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          content: {
            id: "temp-user-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        },
      ],
      uiMessages: [
        {
          id: "temp-user-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "hi" }],
        },
      ],
    });

    expect(newMessages).toHaveLength(1);
    expect(newMessages[0]?.id).toBe("assistant-1");
  });
});

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

describe("buildChatStopConditions", () => {
  it("uses the branded built-in swap tool names", () => {
    archestraMcpBranding.syncFromOrganization({
      appName: "Acme Control Plane",
      iconLogo: null,
    });

    const stopConditions = buildChatStopConditions();
    const toolNames = getChatStopToolNames();

    expect(stopConditions).toHaveLength(3);
    expect(toolNames.swapAgentToolName).toBe("acme_control_plane__swap_agent");
    expect(toolNames.swapToDefaultAgentToolName).toBe(
      "acme_control_plane__swap_to_default_agent",
    );

    archestraMcpBranding.syncFromOrganization(null);
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
      baseUrl: null,
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
      baseUrl: null,
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
      baseUrl: null,
      firstUserMessage: "Test",
      firstAssistantMessage: "",
    });

    expect(result).toBe("Title With Whitespace");
  });

  it("uses fastest model from DB when chatApiKeyId is provided", async () => {
    mockGetFastestModel.mockResolvedValueOnce({ modelId: "db-fast-model" });
    mockGenerateText.mockResolvedValueOnce({ text: "DB Model Title" });

    const result = await generateConversationTitle({
      provider: "anthropic",
      apiKey: "test-key",
      chatApiKeyId: "api-key-123",
      baseUrl: null,
      firstUserMessage: "Hello",
      firstAssistantMessage: "Hi!",
    });

    expect(result).toBe("DB Model Title");
    expect(mockGetFastestModel).toHaveBeenCalledWith("api-key-123");
    expect(createDirectLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: "db-fast-model" }),
    );
  });

  it("falls back to FAST_MODELS when no chatApiKeyId", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "Fallback Title" });

    await generateConversationTitle({
      provider: "anthropic",
      apiKey: "test-key",
      baseUrl: null,
      firstUserMessage: "Hello",
      firstAssistantMessage: "Hi!",
    });

    expect(mockGetFastestModel).not.toHaveBeenCalled();
    expect(createDirectLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: "claude-haiku-4-5-20251001" }),
    );
  });

  it("falls back to FAST_MODELS when getFastestModel returns null", async () => {
    mockGetFastestModel.mockResolvedValueOnce(null);
    mockGenerateText.mockResolvedValueOnce({ text: "Null Fallback Title" });

    await generateConversationTitle({
      provider: "openai",
      apiKey: "test-key",
      chatApiKeyId: "api-key-456",
      baseUrl: null,
      firstUserMessage: "Hello",
      firstAssistantMessage: "Hi!",
    });

    expect(mockGetFastestModel).toHaveBeenCalledWith("api-key-456");
    expect(createDirectLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: "gpt-4o-mini" }),
    );
  });

  it("falls back to FAST_MODELS when getFastestModel throws", async () => {
    mockGetFastestModel.mockRejectedValueOnce(new Error("DB Error"));
    mockGenerateText.mockResolvedValueOnce({ text: "Error Fallback Title" });

    await generateConversationTitle({
      provider: "gemini",
      apiKey: "test-key",
      chatApiKeyId: "api-key-789",
      baseUrl: null,
      firstUserMessage: "Hello",
      firstAssistantMessage: "Hi!",
    });

    expect(mockGetFastestModel).toHaveBeenCalledWith("api-key-789");
    expect(createDirectLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: "gemini-2.0-flash-001" }),
    );
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
