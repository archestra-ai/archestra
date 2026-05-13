// biome-ignore-all lint/suspicious/noExplicitAny: synthetic UIMessage shapes for unit tests
import { convertToModelMessages } from "ai";
import { describe, expect, it, vi } from "vitest";
import db, { schema } from "@/database";
import { MessageModel } from "@/models";
import { test } from "@/test";
import { persistNewMessages as persistNewMessagesForTest } from "./persist-new-messages";

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

  it("pads bedrock messages that only contain ignored UI data parts", () => {
    const messages = __test.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "data-token-usage",
              data: {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
              },
            },
          ],
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

  it("pads bedrock messages that only contain step markers and ignored data parts", () => {
    const messages = __test.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [
        {
          role: "assistant",
          parts: [
            { type: "step-start" },
            {
              type: "data-heartbeat",
              data: { timestamp: 1778603432000 },
            },
          ],
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

  it("pads bedrock messages that only contain streaming tool input", () => {
    const messages = __test.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "tool-search",
              toolCallId: "call_123",
              toolName: "search",
              state: "input-streaming",
              input: { q: "partial" },
            },
          ],
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

  it("pads empty bedrock assistant step blocks before later tool calls", async () => {
    const messages = __test.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [
        {
          role: "assistant",
          parts: [
            { type: "text", text: "" },
            { type: "step-start" },
            {
              type: "tool-search",
              toolCallId: "call_123",
              toolName: "search",
              state: "input-available",
              input: { q: "query" },
            },
          ],
        },
      ],
    });

    const stepStartIndex = messages[0].parts?.findIndex(
      (part) => part.type === "step-start",
    );
    expect(stepStartIndex).toBeGreaterThan(0);
    expect(messages[0].parts?.[stepStartIndex! - 1]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/\S/),
      }),
    );

    const modelMessages = await convertToModelMessages(
      messages as Parameters<typeof convertToModelMessages>[0],
    );
    const assistantMessages = modelMessages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]?.content).toContainEqual(
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

  it("leaves bedrock messages with reasoning that carries provider metadata", () => {
    const message = {
      role: "assistant" as const,
      parts: [
        {
          type: "reasoning",
          text: "thinking...",
          providerMetadata: { bedrock: { signature: "sig-abc" } },
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

  it("dedupes by content fingerprint when content.id is empty and the SDK re-stamps the message id", () => {
    // Reproduces the #4030 phantom: turn 2's assistant was persisted
    // with id="" (AI SDK quirk), then turn 3's request body carries
    // the same assistant under a fresh client-stamped id like
    // `wEHcEHZJOgk2RiwS`. Standard id-based dedupe misses; fingerprint
    // dedupe should catch it.
    const newMessages = __test.getMessagesNotYetPersisted({
      existingMessages: [
        {
          id: "db-user-1",
          content: {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          },
        },
        {
          id: "db-assistant-empty-id",
          content: {
            id: "",
            role: "assistant",
            parts: [
              { type: "step-start" },
              { type: "text", text: "Hello! I'm here to help.", state: "done" },
            ],
          },
        },
      ],
      uiMessages: [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
        {
          id: "wEHcEHZJOgk2RiwS",
          role: "assistant",
          parts: [
            { type: "step-start" },
            { type: "text", text: "Hello! I'm here to help.", state: "done" },
          ],
        },
      ],
    });

    expect(newMessages).toHaveLength(0);
  });

  it("does NOT fingerprint-dedupe an identical assistant reply when the prior row's content.id is non-empty", () => {
    // Counterpart to the empty-content.id test: a model that legitimately
    // produces the same text twice must keep both turns. Fingerprint
    // dedupe only kicks in for rows persisted with empty content.id.
    const newMessages = __test.getMessagesNotYetPersisted({
      existingMessages: [
        {
          id: "db-user-1",
          content: {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          },
        },
        {
          id: "db-assistant-1",
          content: {
            id: "assistant-1",
            role: "assistant",
            parts: [
              { type: "step-start" },
              { type: "text", text: "Hi there!", state: "done" },
            ],
          },
        },
        {
          id: "db-user-2",
          content: {
            id: "user-2",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          },
        },
      ],
      uiMessages: [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [
            { type: "step-start" },
            { type: "text", text: "Hi there!", state: "done" },
          ],
        },
        {
          id: "user-2",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
        {
          id: "assistant-2",
          role: "assistant",
          parts: [
            { type: "step-start" },
            { type: "text", text: "Hi there!", state: "done" },
          ],
        },
      ],
    });

    expect(newMessages).toHaveLength(1);
    expect(newMessages[0]?.id).toBe("assistant-2");
  });

  it("includes reasoning text in the fingerprint so two reasoning blocks with different text are not collapsed", () => {
    const newMessages = __test.getMessagesNotYetPersisted({
      existingMessages: [
        {
          id: "db-assistant-empty-id",
          content: {
            id: "",
            role: "assistant",
            parts: [
              { type: "reasoning", text: "Thinking about A" },
              { type: "text", text: "Done.", state: "done" },
            ],
          },
        },
      ],
      uiMessages: [
        {
          id: "fresh-id",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "Thinking about B" },
            { type: "text", text: "Done.", state: "done" },
          ],
        },
      ],
    });

    expect(newMessages).toHaveLength(1);
    expect(newMessages[0]?.id).toBe("fresh-id");
  });

  it("does NOT fingerprint-dedupe a tool part still in approval-requested state", () => {
    // Approval-pending tools must remain insertable so the
    // approval-resolution sweep can later find and clean them up.
    const newMessages = __test.getMessagesNotYetPersisted({
      existingMessages: [
        {
          id: "db-assistant-prior",
          content: {
            id: "",
            role: "assistant",
            parts: [
              { type: "step-start" },
              {
                type: "tool-foo__bar",
                toolCallId: "tc-1",
                state: "approval-requested",
              },
            ],
          },
        },
      ],
      uiMessages: [
        {
          id: "fresh-id",
          role: "assistant",
          parts: [
            { type: "step-start" },
            {
              type: "tool-foo__bar",
              toolCallId: "tc-1",
              state: "approval-requested",
            },
          ],
        },
      ],
    });

    expect(newMessages).toHaveLength(1);
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

// Helpers for synthetic UIMessage shapes used by the sweep tests below.
type SyntheticPart = Record<string, unknown> & { type: string };
const userMsg = (id = "user-1", text = "go") =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as any;
const assistantMsg = (id: string, parts: SyntheticPart[]) =>
  ({ id, role: "assistant", parts }) as any;
const toolPart = (
  state: string,
  toolCallId = "tc-1",
  approvalId: string | null = "appr-1",
  extra: Record<string, unknown> = {},
): SyntheticPart => ({
  type: "tool-x",
  input: {},
  state,
  toolCallId,
  ...(approvalId !== null
    ? { approval: { id: approvalId, ...(extra.approval ?? {}) } }
    : {}),
  ...extra,
});

const seedStaleApprovalRequested = async (
  conversationId: string,
  contentId = "ai-stale",
  toolCallId = "tc-1",
) => {
  const [row] = await db
    .insert(schema.messagesTable)
    .values({
      conversationId,
      role: "assistant",
      content: {
        id: contentId,
        role: "assistant",
        parts: [
          { type: "step-start" },
          toolPart("approval-requested", toolCallId),
        ],
      } as any,
    })
    .returning();
  return row;
};

describe("persistNewMessages — approval resolution sweep", () => {
  test("approve: removes the prior approval-requested row when a new batch carries approval-responded for the same toolCallId", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conv = await makeConversation(agent.id);
    const stale = await seedStaleApprovalRequested(conv.id);
    const decided = assistantMsg("ai-decided", [
      { type: "step-start" },
      toolPart("approval-responded", "tc-1", "appr-1", {
        approval: { approved: true },
      }),
    ]);

    await persistNewMessagesForTest(conv.id, [userMsg()], "onFinish");
    await persistNewMessagesForTest(conv.id, [userMsg(), decided], "onFinish");

    const remaining = await MessageModel.findByConversation(conv.id);
    expect(remaining.find((m) => m.id === stale.id)).toBeUndefined();
    expect(
      remaining.some((m) => {
        const c = m.content as { parts?: Array<{ state?: string }> };
        return c.parts?.some((p) => p.state === "approval-responded");
      }),
    ).toBe(true);
  });

  test("decline: removes the prior approval-requested row when a new batch carries output-denied for the same toolCallId", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conv = await makeConversation(agent.id);
    const stale = await seedStaleApprovalRequested(conv.id);
    const declined = assistantMsg("ai-declined", [
      toolPart("output-denied", "tc-1", "appr-1", {
        approval: { approved: false, reason: "User denied" },
      }),
    ]);

    await persistNewMessagesForTest(conv.id, [userMsg()], "onFinish");
    await persistNewMessagesForTest(conv.id, [userMsg(), declined], "onFinish");

    const remaining = await MessageModel.findByConversation(conv.id);
    expect(remaining.find((m) => m.id === stale.id)).toBeUndefined();
  });

  test("replaying the same decided batch is a no-op", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conv = await makeConversation(agent.id);
    const decided = assistantMsg("ai-decided", [
      toolPart("approval-responded", "tc-1", "appr-1", {
        approval: { approved: true },
      }),
    ]);

    await persistNewMessagesForTest(conv.id, [userMsg(), decided], "onFinish");
    const after1 = await MessageModel.findByConversation(conv.id);

    await persistNewMessagesForTest(conv.id, [userMsg(), decided], "onFinish");
    const after2 = await MessageModel.findByConversation(conv.id);

    expect(after2.length).toBe(after1.length);
  });

  test("regular tool call (no approval object) is not swept even at terminal state", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conv = await makeConversation(agent.id);
    const response = assistantMsg("ai-resp", [
      toolPart("output-available", "tc-regular", null, { output: "result" }),
    ]);

    await persistNewMessagesForTest(conv.id, [userMsg(), response], "onFinish");

    const all = await MessageModel.findByConversation(conv.id);
    expect(all.length).toBe(2);
  });

  test("legacy approval-requested row self-heals on next decided batch", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conv = await makeConversation(agent.id);
    const stale = await seedStaleApprovalRequested(conv.id);
    const decided = assistantMsg("ai-decided-late", [
      toolPart("approval-responded", "tc-1", "appr-1", {
        approval: { approved: true },
      }),
    ]);

    await persistNewMessagesForTest(conv.id, [userMsg(), decided], "onFinish");

    const remaining = await MessageModel.findByConversation(conv.id);
    expect(remaining.find((m) => m.id === stale.id)).toBeUndefined();
  });

  // Contract: earlyUserMsg must not snapshot the prior assistant in
  // approval-responded state, otherwise onFinish's final output-available +
  // text payload is dropped by content.id dedup.
  test("earlyUserMsg passes user-only; onFinish writes the final assistant state with output and text", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conv = await makeConversation(agent.id);

    const interim = assistantMsg("asst-1", [
      { type: "step-start" },
      toolPart("approval-responded", "tc-1", "appr-1", {
        approval: { approved: true },
      }),
    ]);
    const final = assistantMsg("asst-1", [
      { type: "step-start" },
      toolPart("output-available", "tc-1", "appr-1", {
        approval: { approved: true },
        output: "tool-result",
      }),
      { type: "step-start" },
      { type: "text", state: "done", text: "all done" },
    ]);

    // Mirror routes.ts: earlyUserMsg filters to user role only.
    await persistNewMessagesForTest(
      conv.id,
      [userMsg(), interim].filter((m) => m.role === "user"),
      "earlyUserMsg",
    );
    await persistNewMessagesForTest(conv.id, [userMsg(), final], "onFinish");

    const remaining = await MessageModel.findByConversation(conv.id);
    const persisted = remaining.find((m) => m.role === "assistant");
    const content = persisted?.content as {
      parts?: Array<{ type?: string; state?: string; output?: unknown }>;
    };
    const tool = content?.parts?.find((p) => p.type?.startsWith("tool-"));
    const text = content?.parts?.find((p) => p.type === "text");
    expect(tool?.state).toBe("output-available");
    expect(tool?.output).toBe("tool-result");
    expect(text?.state).toBe("done");
  });

  test("post-sweep: persisted thread has no orphan tool_use for tc-1 (DB precondition for a clean Anthropic follow-up)", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conv = await makeConversation(agent.id);

    // 1. Seed the buggy starting point: a stale approval-requested row.
    await seedStaleApprovalRequested(conv.id);

    // 2. Approve flow lands a final assistant with output-available + text@done.
    const final = assistantMsg("ai-final", [
      { type: "step-start" },
      toolPart("output-available", "tc-1", "appr-1", {
        approval: { approved: true },
        output: "tool-result",
      }),
      { type: "step-start" },
      { type: "text", state: "done", text: "all done" },
    ]);
    await persistNewMessagesForTest(conv.id, [userMsg(), final], "onFinish");

    // 3. User sends a follow-up. The continuation request body is what would
    //    feed Anthropic next — it must contain matching tool_use + tool_result
    //    blocks for tc-1, with no orphan tool_use left from the stale row.
    const followUp = { ...userMsg("user-2", "anything else?") };
    await persistNewMessagesForTest(
      conv.id,
      [userMsg(), final, followUp].filter((m) => m.role === "user"),
      "earlyUserMsg",
    );

    const persisted = await MessageModel.findByConversation(conv.id);

    type PartLike = {
      type?: string;
      state?: string;
      toolCallId?: string;
      output?: unknown;
    };
    const allParts: PartLike[] = persisted.flatMap((m) => {
      const c = m.content as { parts?: PartLike[] };
      return c?.parts ?? [];
    });

    // Exactly one tool_use for tc-1 should remain (the swept-and-replaced row),
    // and it must carry the tool_result via output-available.
    const toolPartsForTc1 = allParts.filter(
      (p) => p.type?.startsWith("tool-") && p.toolCallId === "tc-1",
    );
    expect(toolPartsForTc1).toHaveLength(1);
    expect(toolPartsForTc1[0].state).toBe("output-available");
    expect(toolPartsForTc1[0].output).toBe("tool-result");

    // No persisted assistant row should still be in approval-requested for tc-1.
    const stillRequested = allParts.some(
      (p) => p.toolCallId === "tc-1" && p.state === "approval-requested",
    );
    expect(stillRequested).toBe(false);
  });

  test("post-sweep (decline): persisted thread has no orphan tool_use for tc-1 with declined output (DB precondition)", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conv = await makeConversation(agent.id);

    await seedStaleApprovalRequested(conv.id);

    const declined = assistantMsg("ai-declined", [
      { type: "step-start" },
      toolPart("output-denied", "tc-1", "appr-1", {
        approval: { approved: false },
      }),
      { type: "step-start" },
      { type: "text", state: "done", text: "ok, skipping" },
    ]);
    await persistNewMessagesForTest(conv.id, [userMsg(), declined], "onFinish");

    const followUp = { ...userMsg("user-2", "do something else") };
    await persistNewMessagesForTest(
      conv.id,
      [userMsg(), declined, followUp].filter((m) => m.role === "user"),
      "earlyUserMsg",
    );

    const persisted = await MessageModel.findByConversation(conv.id);
    type PartLike = { type?: string; state?: string; toolCallId?: string };
    const toolPartsForTc1: PartLike[] = persisted
      .flatMap((m) => {
        const c = m.content as { parts?: PartLike[] };
        return c?.parts ?? [];
      })
      .filter((p) => p.type?.startsWith("tool-") && p.toolCallId === "tc-1");

    expect(toolPartsForTc1).toHaveLength(1);
    expect(toolPartsForTc1[0].state).toBe("output-denied");
  });
});
