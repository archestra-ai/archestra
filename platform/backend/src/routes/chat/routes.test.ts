import { convertToModelMessages } from "ai";
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

// Mock createLLMModel to avoid actual API calls
vi.mock("@/clients/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/llm-client")>();
  return {
    ...actual,
    createLLMModel: vi.fn(() => "mocked-model"),
  };
});

import { archestraMcpBranding } from "@/archestra-mcp-server";
import { createLLMModel } from "@/clients/llm-client";
import { ToolCallRepeatTracker } from "@/clients/tool-call-repeat-tracker";
import ConversationModel from "@/models/conversation";
import MessageModel from "@/models/message";
import { test } from "@/test";
import type { ChatMessage } from "@/types";
import { __test as __prepareTest } from "./prepare-model-messages";
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
    const messages = __prepareTest.prepareMessagesForProvider({
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
    const messages = __prepareTest.prepareMessagesForProvider({
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

  it("normalizes json files to text/plain for anthropic", () => {
    const messages = __prepareTest.prepareMessagesForProvider({
      provider: "anthropic",
      messages: [
        {
          role: "user",
          parts: [
            {
              type: "file",
              mediaType: "application/json",
              filename: "data.json",
              url: "data:application/json;base64,eyJhIjoxfQ==",
            },
          ],
        },
      ],
    });

    expect(messages[0].parts?.[0]).toMatchObject({
      type: "file",
      mediaType: "text/plain",
      filename: "data.json",
      url: "data:text/plain;base64,eyJhIjoxfQ==",
    });
  });

  it.each([
    "openai",
    "openrouter",
    "groq",
    "xai",
    "mistral",
    "cohere",
  ] as const)("inlines csv and json file parts as text for %s", (provider) => {
    const messages = __prepareTest.prepareMessagesForProvider({
      provider,
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
            {
              type: "file",
              mediaType: "application/json",
              filename: "data.json",
              url: "data:application/json;base64,eyJhIjoxfQ==",
            },
          ],
        },
      ],
    });

    expect(messages[0].parts).toEqual([
      { type: "text", text: '[Attachment "report.csv" (text/csv)]\n\na,b,c' },
      {
        type: "text",
        text: '[Attachment "data.json" (application/json)]\n\n{"a":1}',
      },
    ]);
  });

  it("leaves image file parts unchanged for convert providers", () => {
    const message = {
      role: "user" as const,
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          filename: "shot.png",
          url: "data:image/png;base64,iVBORw0KGgo=",
        },
      ],
    };

    const messages = __prepareTest.prepareMessagesForProvider({
      provider: "openai",
      messages: [message],
    });

    expect(messages[0]).toBe(message);
  });

  it("leaves text-document file parts unchanged for gemini (inlineData passthrough)", () => {
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

    const messages = __prepareTest.prepareMessagesForProvider({
      provider: "gemini",
      messages: [message],
    });

    expect(messages[0]).toBe(message);
  });

  it("inlines application/csv and excel-as-text for cohere (its SDK relays base64 undecoded otherwise)", () => {
    const messages = __prepareTest.prepareMessagesForProvider({
      provider: "cohere",
      messages: [
        {
          role: "user",
          parts: [
            {
              type: "file",
              mediaType: "application/csv",
              filename: "report.csv",
              url: "data:application/csv;base64,YSxiLGM=",
            },
          ],
        },
      ],
    });

    expect(messages[0].parts).toEqual([
      {
        type: "text",
        text: '[Attachment "report.csv" (application/csv)]\n\na,b,c',
      },
    ]);
  });

  it("leaves an invalid-UTF-8 text-document file part unchanged for convert providers", () => {
    // `//4=` is base64 for bytes [0xFF, 0xFE] — not valid UTF-8 (a binary file
    // mislabeled as a text document). It must NOT be inlined as garbage text.
    const message = {
      role: "user" as const,
      parts: [
        {
          type: "file",
          mediaType: "application/vnd.ms-excel",
          filename: "book.xls",
          url: "data:application/vnd.ms-excel;base64,//4=",
        },
      ],
    };

    const messages = __prepareTest.prepareMessagesForProvider({
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
    const messages = __prepareTest.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [{ role: "user", parts: [pdfFilePart] }],
    });

    expect(messages[0].parts).toEqual([
      { type: "text", text: expect.stringMatching(/\S/) },
      pdfFilePart,
    ]);
  });

  it("prepends placeholder when the only existing text part is whitespace", () => {
    const messages = __prepareTest.prepareMessagesForProvider({
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

    const messages = __prepareTest.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [message],
    });

    expect(messages[0]).toBe(message);
  });

  it("pads bedrock assistant messages whose only text part is whitespace", () => {
    const messages = __prepareTest.prepareMessagesForProvider({
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
    const messages = __prepareTest.prepareMessagesForProvider({
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
    const messages = __prepareTest.prepareMessagesForProvider({
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
    const messages = __prepareTest.prepareMessagesForProvider({
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
    const messages = __prepareTest.prepareMessagesForProvider({
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
    const messages = __prepareTest.prepareMessagesForProvider({
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

    const stepStartIndex =
      messages[0].parts?.findIndex((part) => part.type === "step-start") ?? -1;
    expect(stepStartIndex).toBeGreaterThan(0);
    expect(messages[0].parts?.[stepStartIndex - 1]).toEqual(
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

    const messages = __prepareTest.prepareMessagesForProvider({
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

    const messages = __prepareTest.prepareMessagesForProvider({
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

    const messages = __prepareTest.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [message],
    });

    expect(messages[0]).toBe(message);
  });

  it("normalizes application/json files to text/plain for bedrock", () => {
    const messages = __prepareTest.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "review this" },
            {
              type: "file",
              mediaType: "application/json",
              filename: "data.json",
              url: "data:application/json;base64,eyJhIjoxfQ==",
            },
          ],
        },
      ],
    });

    expect(messages[0].parts?.find((p) => p.type === "file")).toMatchObject({
      type: "file",
      mediaType: "text/plain",
      filename: "data.json",
      url: "data:text/plain;base64,eyJhIjoxfQ==",
    });
  });

  it("leaves bedrock pdf files unchanged after normalization", () => {
    const message = {
      role: "user" as const,
      parts: [
        { type: "text", text: "Summarize this" },
        {
          type: "file",
          mediaType: "application/pdf",
          filename: "report.pdf",
          url: "data:application/pdf;base64,JVBERi0=",
        },
      ],
    };

    const messages = __prepareTest.prepareMessagesForProvider({
      provider: "bedrock",
      messages: [message],
    });

    expect(messages[0].parts?.find((p) => p.type === "file")).toMatchObject({
      mediaType: "application/pdf",
    });
  });
});

describe("buildModelMessagesForProvider", () => {
  // ref-free messages never hit the attachment table, so these run without DB.
  const conversationId = "conv-model-prep";

  it("drops an assistant turn that converts to empty model content", async () => {
    const modelMessages = await __prepareTest.buildModelMessagesForProvider({
      provider: "openai",
      conversationId,
      sandboxAvailable: false,
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          // only provider-invisible parts — convertToModelMessages yields an
          // assistant message with empty content here.
          role: "assistant",
          parts: [
            { type: "step-start" },
            {
              type: "data-tool-ui-start",
              data: { toolCallId: "call_x", toolName: "render_chart" },
            },
          ],
        },
      ],
    });

    expect(modelMessages.map((message) => message.role)).toEqual(["user"]);
  });

  it("keeps normal text and tool assistant turns", async () => {
    const modelMessages = await __prepareTest.buildModelMessagesForProvider({
      provider: "openai",
      conversationId,
      sandboxAvailable: false,
      messages: [
        { role: "user", parts: [{ type: "text", text: "search please" }] },
        {
          role: "assistant",
          parts: [
            { type: "step-start" },
            {
              type: "tool-search",
              toolCallId: "call_ok",
              toolName: "search",
              state: "output-available",
              input: { q: "query" },
              output: { hits: [] },
            },
          ],
        },
        {
          role: "assistant",
          parts: [{ type: "text", text: "Here are the results." }],
        },
      ],
    });

    const assistantMessages = modelMessages.filter(
      (message) => message.role === "assistant",
    );
    // the tool-call turn and the text turn both survive.
    expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
    expect(assistantMessages.at(-1)?.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "Here are the results." }),
    );
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

  it("does not re-persist live messages linked by persisted message metadata", () => {
    const newMessages = __test.getMessagesNotYetPersisted({
      existingMessages: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          content: {
            id: "",
            role: "assistant",
            parts: [{ type: "text", text: "already saved" }],
          },
        },
      ],
      uiMessages: [
        {
          id: "live-assistant-1",
          role: "assistant",
          metadata: {
            persistedMessageId: "22222222-2222-2222-2222-222222222222",
          },
          parts: [{ type: "text", text: "already saved" }],
        } as ChatMessage,
        {
          id: "new-user-1",
          role: "user",
          parts: [{ type: "text", text: "next" }],
        },
      ],
    });

    expect(newMessages).toHaveLength(1);
    expect(newMessages[0]?.id).toBe("new-user-1");
  });

  it("does not re-persist an assistant message saved with an empty content id", () => {
    const newMessages = __test.getMessagesNotYetPersisted({
      existingMessages: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          content: {
            id: "",
            role: "assistant",
            parts: [
              { type: "step-start" },
              {
                type: "text",
                text: "Hello! I see you've started a new chat.",
                state: "done",
              },
            ],
          },
        },
      ],
      uiMessages: [
        {
          id: "assistant-temp-id",
          role: "assistant",
          parts: [
            { type: "step-start" },
            {
              type: "text",
              text: "Hello! I see you've started a new chat.",
              state: "done",
            },
            {
              type: "data-token-usage",
              data: { inputTokens: 10, outputTokens: 20 },
            },
          ],
        },
      ],
    });

    expect(newMessages).toHaveLength(0);
  });

  it("consumes empty content id fallback matches so later repeated text is still persisted", () => {
    const newMessages = __test.getMessagesNotYetPersisted({
      existingMessages: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          content: {
            id: "",
            role: "assistant",
            parts: [
              { type: "step-start" },
              { type: "text", text: "Of course!", state: "done" },
            ],
          },
        },
      ],
      uiMessages: [
        {
          id: "assistant-temp-id",
          role: "assistant",
          parts: [
            { type: "step-start" },
            { type: "text", text: "Of course!", state: "done" },
            {
              type: "data-token-usage",
              data: { inputTokens: 10, outputTokens: 20 },
            },
          ],
        },
        {
          id: "user-2",
          role: "user",
          parts: [{ type: "text", text: "say it again" }],
        },
        {
          id: "assistant-2",
          role: "assistant",
          parts: [
            { type: "step-start" },
            { type: "text", text: "Of course!", state: "done" },
          ],
        },
      ],
    });

    expect(newMessages.map((message) => message.id)).toEqual([
      "user-2",
      "assistant-2",
    ]);
  });
});

describe("persistNewMessages", () => {
  // Regression coverage for #4030: approving or declining a tool and then
  // reloading must restore the resolved turn. The real flow persists four
  // times — the user message and the assistant turn are saved during the
  // first request, then the approval resume re-sends the same turn, which
  // must update the existing assistant row in place rather than appending
  // duplicate rows and orphaning the original approval-requested row.
  const userMessage = {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "Run the print test tool." }],
  };

  const printToolPart = {
    type: "tool-print_test",
    toolCallId: "call-1",
    input: {},
  };

  const approvalRequested = {
    id: "assistant-1",
    role: "assistant",
    parts: [{ ...printToolPart, state: "approval-requested" }],
  };

  // The approval resume re-sends the assistant turn with the answer applied.
  const approvalResponded = {
    id: "assistant-1",
    role: "assistant",
    parts: [{ ...printToolPart, state: "approval-responded" }],
  };

  const resolvedCases = [
    {
      decision: "approved",
      toolState: "output-available",
      resolvedAssistant: {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            ...printToolPart,
            state: "output-available",
            output: { result: ["archestra-4030-repro"] },
          },
          { type: "text", text: "The print test tool ran successfully." },
        ],
      },
    },
    {
      decision: "declined",
      toolState: "output-denied",
      resolvedAssistant: {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { ...printToolPart, state: "output-denied" },
          { type: "text", text: "Understood, I will not run that tool." },
        ],
      },
    },
  ];

  for (const testCase of resolvedCases) {
    test(`reconciles the resolved turn after a tool call is ${testCase.decision}, without duplicate rows (#4030)`, async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAgent,
    }) => {
      const user = await makeUser();
      const organization = await makeOrganization();
      await makeMember(user.id, organization.id, { role: "admin" });
      const agent = await makeAgent({
        organizationId: organization.id,
        authorId: user.id,
        scope: "personal",
      });
      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: organization.id,
        agentId: agent.id,
        selectedModel: "gpt-4o",
        selectedProvider: "openai",
      });

      // First request: the user message is persisted early, then the
      // assistant turn is persisted on finish while the tool waits for
      // approval.
      await __test.persistNewMessages(
        conversation.id,
        [userMessage],
        "earlyUserMsg",
      );
      await __test.persistNewMessages(
        conversation.id,
        [userMessage, approvalRequested],
        "onFinish",
      );

      // Resume request: the client re-sends the answered turn. The early
      // persist must not duplicate it, and the finish persist must update
      // the existing assistant row to its resolved state.
      await __test.persistNewMessages(
        conversation.id,
        [userMessage, approvalResponded],
        "earlyUserMsg",
      );
      await __test.persistNewMessages(
        conversation.id,
        [userMessage, testCase.resolvedAssistant],
        "onFinish",
      );

      const stored = await MessageModel.findByConversation(conversation.id);
      expect(stored.filter((row) => row.role === "user")).toHaveLength(1);

      const assistantRows = stored.filter((row) => row.role === "assistant");
      expect(assistantRows).toHaveLength(1);

      const storedParts: Array<Record<string, unknown>> =
        assistantRows[0]?.content?.parts ?? [];
      const resolvedToolPart = storedParts.find(
        (part) => part.toolCallId === "call-1",
      );
      expect(resolvedToolPart?.state).toBe(testCase.toolState);
      expect(storedParts.some((part) => part.type === "text")).toBe(true);
    });
  }
});

describe("getMessagesWithChangedContent", () => {
  it("only updates rows still in approval-requested state, matched by toolCallId", () => {
    // The narrow scope: this update path resolves an approval-requested tool
    // call by toolCallId. Unrelated content changes on other rows are ignored
    // so a client can't repurpose this path to overwrite earlier messages —
    // those edits still go through updateTextPartAndDeleteSubsequent.
    const changed = __test.getMessagesWithChangedContent({
      existingMessages: [
        {
          id: "db-text",
          content: {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        },
        {
          id: "db-pending",
          content: {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-print_test",
                toolCallId: "call-1",
                state: "approval-requested",
                input: {},
              },
            ],
          },
        },
      ],
      uiMessages: [
        // Unrelated text edit — must be ignored.
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "hello (edited)" }],
        },
        // Resolved version of the approval-requested call.
        {
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "tool-print_test",
              toolCallId: "call-1",
              state: "output-available",
              input: {},
              output: { ok: true },
            },
            { type: "text", text: "done" },
          ],
        },
      ],
    });

    expect(changed).toHaveLength(1);
    expect(changed[0]?.id).toBe("db-pending");
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
    expect(prompt).toContain("Chat conversation messages:");
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

  it("leaves title formatting instructions to the system prompt", () => {
    const prompt = buildTitlePrompt("Hello", "Hi there");

    expect(prompt).toContain("User: Hello");
    expect(prompt).toContain("Assistant: Hi there");
    expect(prompt).not.toContain("Respond with ONLY the title");
  });
});

describe("buildChatStopConditions", () => {
  it("uses the branded built-in swap tool names", () => {
    archestraMcpBranding.syncFromOrganization({
      appName: "Acme Control Plane",
      iconLogo: null,
    });

    const stopConditions = buildChatStopConditions(new ToolCallRepeatTracker());
    const toolNames = getChatStopToolNames();

    expect(stopConditions).toHaveLength(4);
    expect(toolNames.swapAgentToolName).toBe("acme_control_plane__swap_agent");
    expect(toolNames.swapToDefaultAgentToolName).toBe(
      "acme_control_plane__swap_to_default_agent",
    );

    archestraMcpBranding.syncFromOrganization(null);
  });
});

describe("generateConversationTitle", () => {
  it("returns null when LLM call fails", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("API Error"));

    const result = await generateConversationTitle({
      provider: "anthropic",
      apiKey: "test-key",
      modelName: "claude-test",
      baseUrl: null,
      agentId: "title-agent-id",
      userId: "user-id",
      conversationId: "conversation-id",
      systemPrompt: "Generate a title.",
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
      modelName: "gpt-test",
      baseUrl: null,
      agentId: "title-agent-id",
      userId: "user-id",
      conversationId: "conversation-id",
      systemPrompt: "Generate a title.",
      firstUserMessage: "Test",
      firstAssistantMessage: "",
    });

    expect(result).toBe("Title With Whitespace");
  });

  it("uses the resolved built-in agent model and system prompt", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "Configured Model Title" });

    const result = await generateConversationTitle({
      provider: "anthropic",
      apiKey: "test-key",
      modelName: "configured-title-model",
      baseUrl: null,
      agentId: "title-agent-id",
      userId: "user-id",
      conversationId: "conversation-id",
      systemPrompt: "Return only a title.",
      firstUserMessage: "Hello",
      firstAssistantMessage: "Hi!",
    });

    expect(result).toBe("Configured Model Title");
    expect(createLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "title-agent-id",
        modelName: "configured-title-model",
        userId: "user-id",
        sessionId: "conversation-id",
        source: "chat:title_generation",
      }),
    );
    expect(mockGenerateText).toHaveBeenCalledWith({
      model: "mocked-model",
      system: "Return only a title.",
      prompt: "Chat conversation messages:\n\nUser: Hello\n\nAssistant: Hi!",
      maxOutputTokens: 64,
    });
  });

  it("caps output tokens so non-streaming requests stay under the provider limit", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "Short Title" });

    await generateConversationTitle({
      provider: "anthropic",
      apiKey: "test-key",
      modelName: "claude-test",
      baseUrl: null,
      agentId: "title-agent-id",
      userId: "user-id",
      conversationId: "conversation-id",
      systemPrompt: "Generate a title.",
      firstUserMessage: "Hello",
      firstAssistantMessage: "Hi!",
    });

    const callArg = mockGenerateText.mock.calls[0][0];
    expect(callArg.maxOutputTokens).toBeLessThanOrEqual(64);
    expect(callArg.maxOutputTokens).toBeGreaterThan(0);
  });
});
