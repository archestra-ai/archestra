// Real-boundary tests for executeA2AMessage: only the LLM model, MCP tools, and
// DB lookups are mocked — `streamText` and `runAgentStream` run for real against
// a MockLanguageModelV3. This exercises the multi-consumer stream (probe +
// toUIMessageStream + text/usage/finishReason), the captured-error → ProviderError
// mapping, and the context-trim recovery on the A2A `messages` path — none of
// which the mocked-streamText suite in a2a-executor.test.ts can prove.

import { ChatErrorCode } from "@archestra/shared";
import type { ModelMessage } from "ai";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  REPEAT_CALL_TERMINATION_CEILING,
  REPEAT_CALL_TERMINATION_NOTICE,
  type ToolCallRepeatTracker,
} from "@/clients/tool-call-repeat-tracker";
import { ProviderError } from "@/routes/chat/errors";
import { executeA2AMessage } from "./a2a-executor";

const {
  mockGetChatMcpTools,
  mockCreateLLMModelForAgent,
  mockResolveConversationLlmSelectionForAgent,
} = vi.hoisted(() => ({
  mockGetChatMcpTools: vi.fn(),
  mockCreateLLMModelForAgent: vi.fn(),
  mockResolveConversationLlmSelectionForAgent: vi.fn(),
}));

vi.mock("@/clients/chat-mcp-client", () => ({
  closeChatMcpClient: vi.fn(),
  getChatMcpTools: (...args: unknown[]) => mockGetChatMcpTools(...args),
}));

vi.mock("@/clients/llm-client", () => ({
  createLLMModelForAgent: (...args: unknown[]) =>
    mockCreateLLMModelForAgent(...args),
}));

vi.mock("@/utils/llm-resolution", async () => {
  const actual = await vi.importActual<typeof import("@/utils/llm-resolution")>(
    "@/utils/llm-resolution",
  );
  return {
    ...actual,
    resolveConversationLlmSelectionForAgent: (...args: unknown[]) =>
      mockResolveConversationLlmSelectionForAgent(...args),
  };
});

vi.mock("@/features/browser-stream/services/browser-stream.feature", () => ({
  browserStreamFeature: {
    isEnabled: vi.fn().mockReturnValue(false),
    closeTab: vi.fn(),
  },
}));

vi.mock("@/clients/mcp-client", () => ({
  default: { closeSession: vi.fn() },
}));

vi.mock("@/models", async () => {
  const actual = await vi.importActual<typeof import("@/models")>("@/models");
  return {
    ...actual,
    AgentModel: { findById: vi.fn() },
    McpServerModel: { getUserPersonalServerForCatalog: vi.fn() },
  };
});

vi.mock("@/templating", async () => {
  const actual =
    await vi.importActual<typeof import("@/templating")>("@/templating");
  return {
    ...actual,
    promptNeedsRendering: vi.fn(() => false),
    renderSystemPrompt: vi.fn((prompt: string) => prompt),
  };
});

import { AgentModel, McpServerModel } from "@/models";

type StreamResult = Extract<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>["doStream"],
  { stream: unknown }
>;
type ModelStreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

function textChunks(text: string): ModelStreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: text },
    { type: "text-end", id: "1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ];
}

// A content-free turn: only a finish event, no text — the probe treats it as an
// empty (retryable) response.
function emptyChunks(): ModelStreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ];
}

function contextLengthErrorChunks(maxTokens: number): ModelStreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "error", error: new Error(`maximum input length of ${maxTokens}`) },
    { type: "finish", finishReason: { unified: "error", raw: "error" }, usage },
  ];
}

// A model whose `doStream` walks the provided per-attempt chunk lists; the final
// entry repeats so an unexpected extra attempt fails on assertions, not setup.
function modelEmitting(...attempts: ModelStreamPart[][]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = attempts[Math.min(call, attempts.length - 1)];
      call++;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

function primeAgent(model: MockLanguageModelV3) {
  vi.mocked(AgentModel.findById).mockResolvedValue({
    id: "agent-child",
    name: "Child Agent",
    agentType: "agent",
    systemPrompt: "Handle the task.",
    llmApiKeyId: null,
    modelId: null,
  } as never);
  vi.mocked(McpServerModel.getUserPersonalServerForCatalog).mockResolvedValue(
    null,
  );
  mockResolveConversationLlmSelectionForAgent.mockResolvedValue({
    chatApiKeyId: "org-key",
    selectedModel: "gemini-2.5-pro",
    selectedProvider: "gemini",
  });
  mockGetChatMcpTools.mockResolvedValue({});
  mockCreateLLMModelForAgent.mockResolvedValue({
    model,
    provider: "gemini",
    apiKeySource: "org",
  });
}

describe("executeA2AMessage real stream boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("collects text, finishReason, and the response message from a real stream", async () => {
    primeAgent(modelEmitting(textChunks("Hello from A2A")));

    const result = await executeA2AMessage({
      agentId: "agent-child",
      message: "Handle this",
      organizationId: "org-1",
      userId: "user-1",
      conversationId: "conv-1",
    });

    expect(result.text).toBe("Hello from A2A");
    expect(result.finishReason).toBe("stop");
    expect(result.responseUiMessage.role).toBe("assistant");
    expect(result.usage?.promptTokens).toBe(5);
    expect(result.usage?.completionTokens).toBe(2);
  });

  test("surfaces the captured provider cause, not a generic NoOutputGeneratedError", async () => {
    // A provider failure (e.g. billing) makes streamText produce zero output and
    // throw NoOutputGeneratedError; the real cause is only available via the
    // captured onError, which a2a must map into the ProviderError.
    const billing = new Error("Insufficient credits: 402");
    primeAgent(
      new MockLanguageModelV3({
        doStream: async () => {
          throw billing;
        },
      }),
    );

    const error = await executeA2AMessage({
      agentId: "agent-child",
      message: "Handle this",
      organizationId: "org-1",
      userId: "user-1",
      conversationId: "conv-1",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain("Insufficient credits");
  });

  test("maps an exhausted empty response to a ProviderError EmptyResponse", async () => {
    // every attempt is content-free, so the recovery loop exhausts and throws
    // EmptyModelResponseError, which a2a maps to the EmptyResponse card.
    const model = modelEmitting(emptyChunks());
    primeAgent(model);

    const error = await executeA2AMessage({
      agentId: "agent-child",
      message: "Handle this",
      organizationId: "org-1",
      userId: "user-1",
      conversationId: "conv-1",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).chatErrorResponse.code).toBe(
      ChatErrorCode.EmptyResponse,
    );
    expect(model.doStreamCalls).toHaveLength(3);
  });

  test("trims and retries a context-length rejection on the A2A messages path", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "a".repeat(400) },
      { role: "assistant", content: "b".repeat(400) },
      { role: "user", content: "c".repeat(400) },
    ];
    const model = modelEmitting(
      contextLengthErrorChunks(5),
      textChunks("Recovered after trim"),
    );
    primeAgent(model);

    const result = await executeA2AMessage({
      agentId: "agent-child",
      message: "ignored when messages provided",
      organizationId: "org-1",
      userId: "user-1",
      conversationId: "conv-1",
      messages,
    });

    expect(model.doStreamCalls).toHaveLength(2);
    // the retry resent a trimmed (shorter) prompt
    expect(model.doStreamCalls[1].prompt.length).toBeLessThan(
      model.doStreamCalls[0].prompt.length,
    );
    expect(result.text).toBe("Recovered after trim");
  });

  test("stops via the repeat-call ceiling and surfaces a termination notice as text", async () => {
    // The model repeats the same tool call every step (unique call ids, identical
    // name+args), so the run's tracker streak climbs to the ceiling.
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: `tc-${step++}`,
              toolName: "stuck_tool",
              input: "{}",
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage,
            },
          ],
        }),
      }),
    });
    primeAgent(model);

    // Stand in for the real breaker (which lives in the mocked getChatMcpTools):
    // record into the run's tracker and skip execution. The run hands its own
    // tracker to getChatMcpTools and reads the same instance in its stopWhen.
    let captured: ToolCallRepeatTracker | undefined;
    mockGetChatMcpTools.mockImplementation(
      ({ repeatTracker }: { repeatTracker: ToolCallRepeatTracker }) => {
        captured = repeatTracker;
        return Promise.resolve({
          stuck_tool: tool({
            description: "always repeated",
            inputSchema: z.object({}),
            execute: async () => {
              repeatTracker.record("stuck_tool", {});
              return "skipped: repeated call";
            },
          }),
        });
      },
    );

    const result = await executeA2AMessage({
      agentId: "agent-child",
      message: "Handle this",
      organizationId: "org-1",
      userId: "user-1",
      conversationId: "conv-1",
    });

    // The loop stopped once the streak hit the ceiling, before MAX_AGENT_STEPS.
    expect(captured?.hasReachedTerminationCeiling()).toBe(true);
    expect(model.doStreamCalls).toHaveLength(REPEAT_CALL_TERMINATION_CEILING);
    // No assistant text was produced, so the caller-visible notice stands in.
    expect(result.text).toBe(REPEAT_CALL_TERMINATION_NOTICE);
  });
});
