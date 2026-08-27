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
import { vi } from "vitest";
import { z } from "zod";
import {
  REPEAT_CALL_TERMINATION_CEILING,
  REPEAT_CALL_TERMINATION_NOTICE,
  type ToolCallRepeatTracker,
} from "@/clients/tool-call-repeat-tracker";
import { ProviderError, SubagentProviderError } from "@/routes/chat/errors";
import { THINKING_ONLY_NOTICE } from "@/utils/strip-thinking-blocks";
import { executeA2AMessage } from "./a2a-executor";

const {
  mockGetChatMcpTools,
  mockCreateLLMModelForAgent,
  mockResolveConversationLlmSelectionForAgent,
  mockIsOpenAiReasoningSummaryMarkedUnsupported,
  mockMarkOpenAiReasoningSummaryUnsupported,
} = vi.hoisted(() => ({
  mockGetChatMcpTools: vi.fn(),
  mockCreateLLMModelForAgent: vi.fn(),
  mockResolveConversationLlmSelectionForAgent: vi.fn(),
  mockIsOpenAiReasoningSummaryMarkedUnsupported: vi.fn(),
  mockMarkOpenAiReasoningSummaryUnsupported: vi.fn(),
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

// Cache verdict boundary only — the detector and the strip-retry stay real so
// these tests exercise the actual recovery. Unset (→ awaited falsy) the check
// means summaries are requested; the negative-cache test flips it. The mark is
// mocked so the wiring test can observe the verdict write.
vi.mock("@/agents/openai-reasoning-summary", async () => {
  const actual = await vi.importActual<
    typeof import("@/agents/openai-reasoning-summary")
  >("@/agents/openai-reasoning-summary");
  return {
    ...actual,
    isOpenAiReasoningSummaryMarkedUnsupported: (...args: unknown[]) =>
      mockIsOpenAiReasoningSummaryMarkedUnsupported(...args),
    markOpenAiReasoningSummaryUnsupported: (...args: unknown[]) =>
      mockMarkOpenAiReasoningSummaryUnsupported(...args),
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

vi.mock("@/templating", async () => {
  const actual =
    await vi.importActual<typeof import("@/templating")>("@/templating");
  return {
    ...actual,
    promptNeedsRendering: vi.fn(() => false),
    renderSystemPrompt: vi.fn((prompt: string) => prompt),
  };
});

import { beforeEach, describe, expect, test } from "@/test";

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

// Emits one `text-delta` per supplied fragment so a test can observe the
// incremental deltas a streaming caller would receive.
function multiTextChunks(...deltas: string[]): ModelStreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "1" },
    ...deltas.map((delta) => ({
      type: "text-delta" as const,
      id: "1",
      delta,
    })),
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

function modelCapturingPrompt(
  capture: (prompt: unknown) => void,
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async (options) => {
      capture(options.prompt);
      return {
        stream: simulateReadableStream({
          chunks: textChunks("cache-aware response"),
        }),
      };
    },
  });
}

// Primes only the non-DB boundaries (LLM selection, model factory, MCP tools).
// The agent itself is a real row created per test; findById hits real PGlite.
function primeAgent(model: MockLanguageModelV3) {
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

function primePromptCacheAgent(params: {
  model: MockLanguageModelV3;
  provider: "anthropic" | "bedrock";
  selectedModel: string;
  anthropicNativeEndpoint: boolean;
}) {
  mockResolveConversationLlmSelectionForAgent.mockResolvedValue({
    chatApiKeyId: "org-key",
    selectedModel: params.selectedModel,
    selectedProvider: params.provider,
  });
  mockGetChatMcpTools.mockResolvedValue({});
  mockCreateLLMModelForAgent.mockResolvedValue({
    model: params.model,
    provider: params.provider,
    apiKeySource: "org",
    anthropicNativeEndpoint: params.anthropicNativeEndpoint,
  });
}

// OpenAI variant of primeAgent: a Responses-routed model (gpt-5.6) resolved to
// a stored credential, so the reasoning-summary gate is in play.
function primeOpenAiAgent(model: MockLanguageModelV3) {
  mockResolveConversationLlmSelectionForAgent.mockResolvedValue({
    chatApiKeyId: "org-key",
    selectedModel: "gpt-5.6",
    selectedProvider: "openai",
  });
  mockGetChatMcpTools.mockResolvedValue({});
  mockCreateLLMModelForAgent.mockResolvedValue({
    model,
    provider: "openai",
    apiKeySource: "org",
    chatApiKeyId: "credential-1",
  });
}

// The unverified-org rejection surfaced as a stream error part, the shape the
// probe sees when OpenAI 400s the whole request over `reasoning.summary`.
function reasoningSummaryVerificationErrorChunks(): ModelStreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "error",
      error: new Error(
        "Your organization must be verified to generate reasoning summaries.",
      ),
    },
    { type: "finish", finishReason: { unified: "error", raw: "error" }, usage },
  ];
}

describe("executeA2AMessage real stream boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("collects text, finishReason, and the response message from a real stream", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    primeAgent(modelEmitting(textChunks("Hello from A2A")));

    const result = await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
    });

    expect(result.text).toBe("Hello from A2A");
    expect(result.finishReason).toBe("stop");
    expect(result.responseUiMessage.role).toBe("assistant");
    expect(result.usage?.promptTokens).toBe(5);
    expect(result.usage?.completionTokens).toBe(2);
  });

  test("sends Anthropic cache control through the real A2A stream boundary", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    let modelPrompt: unknown;
    primePromptCacheAgent({
      provider: "anthropic",
      selectedModel: "claude-opus-4-8",
      anthropicNativeEndpoint: true,
      model: modelCapturingPrompt((prompt) => {
        modelPrompt = prompt;
      }),
    });

    await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
    });

    expect(JSON.stringify(modelPrompt)).toContain(
      '"cacheControl":{"type":"ephemeral","ttl":"1h"}',
    );
  });

  test("sends Bedrock cache control through the real A2A stream boundary", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    let modelPrompt: unknown;
    primePromptCacheAgent({
      provider: "bedrock",
      selectedModel: "amazon.nova-lite-v1:0",
      anthropicNativeEndpoint: false,
      model: modelCapturingPrompt((prompt) => {
        modelPrompt = prompt;
      }),
    });

    await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
    });

    expect(JSON.stringify(modelPrompt)).toContain(
      '"cachePoint":{"type":"default"}',
    );
  });

  test("forwards each incremental text delta to onTextDelta while still returning the buffered result", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    primeAgent(modelEmitting(multiTextChunks("Hello ", "from ", "A2A")));

    const deltas: string[] = [];
    const result = await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
      onTextDelta: (delta) => deltas.push(delta),
    });

    // The deltas arrive incrementally and reassemble into the buffered answer.
    expect(deltas).toEqual(["Hello ", "from ", "A2A"]);
    expect(result.text).toBe("Hello from A2A");
  });

  test("a throwing onTextDelta callback does not abort the buffered run", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    primeAgent(modelEmitting(textChunks("Resilient answer")));

    // A forward failure (e.g. the SSE socket closed) must be swallowed so the
    // run still completes and returns its buffered result.
    const result = await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
      onTextDelta: () => {
        throw new Error("client disconnected");
      },
    });

    expect(result.text).toBe("Resilient answer");
  });

  test("strips inline <thinking> blocks from the text and the response message", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    primeAgent(
      modelEmitting(
        textChunks("Answer.<thinking>secret reasoning</thinking> Done."),
      ),
    );

    const result = await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
    });

    expect(result.text).toBe("Answer. Done.");
    const textPart = result.responseUiMessage.parts.find(
      (p): p is Extract<typeof p, { type: "text" }> => p.type === "text",
    );
    expect(textPart?.text).toBe("Answer. Done.");
  });

  test("strips Qwen-style <think> blocks so reasoning does not leak into the A2A reply", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    primeAgent(
      modelEmitting(
        textChunks("<think>The user wants a task.</think>Created the task."),
      ),
    );

    const result = await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
    });

    expect(result.text).toBe("Created the task.");
    expect(result.text).not.toContain("<think>");
    const textPart = result.responseUiMessage.parts.find(
      (p): p is Extract<typeof p, { type: "text" }> => p.type === "text",
    );
    expect(textPart?.text).toBe("Created the task.");
  });

  test("substitutes a notice when a thinking-only turn strips to nothing", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    // The pre-strip stream is non-empty, so the empty-response recovery does not
    // re-trigger; stripping leaves no visible answer, so the notice stands in —
    // in both the headless text and the message's text part.
    primeAgent(
      modelEmitting(textChunks("<thinking>only reasoning</thinking>")),
    );

    const result = await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
    });

    expect(result.text).toBe(THINKING_ONLY_NOTICE);
    const textPart = result.responseUiMessage.parts.find(
      (p): p is Extract<typeof p, { type: "text" }> => p.type === "text",
    );
    expect(textPart?.text).toBe(THINKING_ONLY_NOTICE);
  });

  test("surfaces the captured provider cause, not a generic NoOutputGeneratedError", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
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
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain("Insufficient credits");
  });

  test("preserves the subagent origin on a captured provider error", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    const providerError = new ProviderError({
      code: ChatErrorCode.RateLimit,
      message: "usage limit reached",
      isRetryable: false,
    });
    const subagentError = new SubagentProviderError({
      providerError,
      subagentId: "00000000-0000-0000-0000-000000000099",
      subagentName: "Research Helper",
    });
    primeAgent(
      new MockLanguageModelV3({
        doStream: async () => {
          throw subagentError;
        },
      }),
    );

    const error = await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
    }).catch((caught: unknown) => caught);

    expect(error).toBe(subagentError);
  });

  test("maps an exhausted empty response to a ProviderError EmptyResponse", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    // every attempt is content-free, so the recovery loop exhausts and throws
    // EmptyModelResponseError, which a2a maps to the EmptyResponse card.
    const model = modelEmitting(emptyChunks());
    primeAgent(model);

    const error = await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).chatErrorResponse.code).toBe(
      ChatErrorCode.EmptyResponse,
    );
    expect(model.doStreamCalls).toHaveLength(3);
  });

  test("trims and retries a context-length rejection on the A2A messages path", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
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
      agentId: agent.id,
      message: "ignored when messages provided",
      organizationId: org.id,
      userId: user.id,
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

  test("requests OpenAI reasoning summaries on a Responses-routed a2a turn", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    const model = modelEmitting(textChunks("Summarized answer"));
    primeOpenAiAgent(model);

    const result = await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
    });

    expect(result.text).toBe("Summarized answer");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.providerOptions?.openai).toEqual({
      store: false,
      reasoningSummary: "auto",
    });
  });

  test("omits reasoningSummary on an a2a turn while the credential is negative-cached", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    const model = modelEmitting(textChunks("Plain answer"));
    primeOpenAiAgent(model);
    mockIsOpenAiReasoningSummaryMarkedUnsupported.mockResolvedValueOnce(true);

    const result = await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
    });

    expect(result.text).toBe("Plain answer");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.providerOptions?.openai).toEqual({
      store: false,
    });
  });

  test("negative-caches the resolved credential and retries without summaries on the verification 400", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
    const model = modelEmitting(
      reasoningSummaryVerificationErrorChunks(),
      textChunks("Recovered without summaries"),
    );
    primeOpenAiAgent(model);

    const result = await executeA2AMessage({
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
    });

    expect(result.text).toBe("Recovered without summaries");
    expect(model.doStreamCalls).toHaveLength(2);
    // the retry dropped only the summary option; store:false must survive
    expect(model.doStreamCalls[1]?.providerOptions?.openai).toEqual({
      store: false,
    });
    // the verdict is keyed by the credential the turn ran on, not the
    // agent's configured key
    expect(mockMarkOpenAiReasoningSummaryUnsupported).toHaveBeenCalledTimes(1);
    expect(mockMarkOpenAiReasoningSummaryUnsupported).toHaveBeenCalledWith(
      `openai-reasoning-summary-unsupported-${org.id}:credential-1`,
    );
  });

  test("stops via the repeat-call ceiling and surfaces a termination notice as text", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeInternalAgent({ organizationId: org.id });
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
      agentId: agent.id,
      message: "Handle this",
      organizationId: org.id,
      userId: user.id,
      conversationId: "conv-1",
    });

    // The loop stopped once the streak hit the ceiling, before MAX_AGENT_STEPS.
    expect(captured?.hasReachedTerminationCeiling()).toBe(true);
    expect(model.doStreamCalls).toHaveLength(REPEAT_CALL_TERMINATION_CEILING);
    // No assistant text was produced, so the caller-visible notice stands in.
    expect(result.text).toBe(REPEAT_CALL_TERMINATION_NOTICE);
  });
});
