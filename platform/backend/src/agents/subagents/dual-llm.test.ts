import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { createLLMModel, isApiKeyRequired } from "@/clients/llm-client";
import AgentModel from "@/models/agent";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { InsertAgent } from "@/types";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";
import { DualLlmAgentCallError, DualLlmSubagent } from "./dual-llm";

// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper (per-test MSW server), not a React hook
const server = useMswServer();

// Boundary mock: the real `ai` SDK runs generateText and MSW serves the
// provider wire responses. The only internal seam we keep is the proxied
// model factory, pointed at a fake base URL the MSW server intercepts.
const LLM_BASE_URL = "https://llm.test/v1";

vi.mock("@/clients/llm-client", async () => {
  const { createOpenAI } = await import("@ai-sdk/openai");
  // Literal (not the module-level const) — this factory is hoisted above it.
  const model = createOpenAI({
    baseURL: "https://llm.test/v1",
    apiKey: "test-key",
  }).chat("gpt-4o-mini");
  return {
    createLLMModel: vi.fn(() => model),
    isApiKeyRequired: vi.fn(() => false),
  };
});

// Minimal OpenAI chat-completions body the @ai-sdk/openai provider accepts.
function chatCompletion(content: string) {
  return HttpResponse.json({
    id: "chatcmpl-test",
    created: 0,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

// The prompt built by dual-llm rides in the trailing user message.
function lastUserPrompt(body: {
  messages: Array<{ role: string; content: string }>;
}): string {
  const userMessages = body.messages.filter((m) => m.role === "user");
  return userMessages.at(-1)?.content ?? "";
}

// The quarantine agent's answer prompt carries the bare-integer directive;
// question/summary prompts do not.
function isQuarantinePrompt(prompt: string): boolean {
  return prompt.includes("Respond with ONLY the index number");
}

vi.mock("@/utils/llm-resolution", () => ({
  resolveAgentLlmOrDefault: vi.fn(),
}));

vi.mock("@/templating", () => ({
  renderSystemPrompt: vi.fn(
    (prompt: string | null | undefined) => prompt ?? "",
  ),
}));

const MOCK_RESOLVED_LLM = {
  provider: "anthropic" as const,
  apiKey: "sk-ant-test-key",
  modelName: "claude-3-5-sonnet-20241022",
  baseUrl: null,
};

function buildBuiltInAgentOverrides(params: {
  name: (typeof BUILT_IN_AGENT_IDS)[keyof typeof BUILT_IN_AGENT_IDS];
  systemPrompt: string;
  maxRounds?: number;
}): Partial<InsertAgent> {
  return {
    scope: "org",
    name: params.name,
    agentType: "agent",
    systemPrompt: params.systemPrompt,
    builtInAgentConfig:
      params.name === BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN
        ? {
            name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
            maxRounds: params.maxRounds ?? 5,
          }
        : params.name === BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE
          ? {
              name: BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
            }
          : {
              name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
              autoConfigureOnToolDiscovery: false,
            },
  };
}

describe("DualLlmSubagent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveAgentLlmOrDefault).mockResolvedValue(MOCK_RESOLVED_LLM);
    // clearAllMocks does not reset implementations installed with
    // mockReturnValue — re-arm the default so per-test overrides can't leak.
    vi.mocked(isApiKeyRequired).mockReturnValue(false);
  });

  test("throws when dual LLM built-in agents are missing", async () => {
    vi.spyOn(AgentModel, "getBuiltInAgent").mockResolvedValue(null);

    await expect(
      DualLlmSubagent.create({
        dualLlmParams: {
          toolCallId: "tool-call-1",
          userRequest: "summarize this",
          toolResult: { raw: "data" },
          toolName: "get_emails",
        },
        callingAgentId: "agent-1",
        organizationId: "org-1",
      }),
    ).rejects.toThrow("Dual LLM built-in agents are not seeded");
  });

  test("uses built-in agents to run the question/answer/summary flow", async ({
    makeAgent,
  }) => {
    const mainAgent = await makeAgent(
      buildBuiltInAgentOverrides({
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
        systemPrompt: "main prompt",
        maxRounds: 2,
      }),
    );
    const quarantineAgent = await makeAgent(
      buildBuiltInAgentOverrides({
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
        systemPrompt: "quarantine prompt",
      }),
    );

    vi.spyOn(AgentModel, "getBuiltInAgent").mockImplementation(async (name) => {
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN) {
        return mainAgent;
      }
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE) {
        return quarantineAgent;
      }
      return null;
    });

    const textPrompts: string[] = [];
    let quarantineRequestCount = 0;
    server.use(
      http.post(`${LLM_BASE_URL}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as {
          messages: Array<{ role: string; content: string }>;
        };

        const prompt = lastUserPrompt(body);
        // The quarantine agent answers with a bare option index; parsing is
        // lenient, so a chatty reply still resolves.
        if (isQuarantinePrompt(prompt)) {
          quarantineRequestCount += 1;
          return chatCompletion("Answer: 0");
        }

        textPrompts.push(prompt);
        if (prompt.includes("SUMMARY MODE")) {
          return chatCompletion("Safe summary");
        }
        // First question round proposes a question; the second signals DONE.
        const questionRounds = textPrompts.filter((p) =>
          p.includes("QUESTION MODE"),
        ).length;
        return questionRounds === 1
          ? chatCompletion(
              "QUESTION: What kind of data is present?\nOPTIONS:\n0: email metadata\n1: source code\n2: not determinable",
            )
          : chatCompletion("DONE");
      }),
    );

    const subagent = await DualLlmSubagent.create({
      dualLlmParams: {
        toolCallId: "tool-call-1",
        userRequest: "summarize this safely",
        toolResult: { raw: "sensitive data" },
        toolName: "get_emails",
        toolArguments: { folder: "inbox" },
      },
      callingAgentId: "agent-1",
      organizationId: "org-1",
    });

    const progress = vi.fn();
    const result = await subagent.processWithMainAgent(progress);

    // Three main-agent generations (two question rounds + final summary) and
    // one answer from the quarantine agent.
    expect(textPrompts).toHaveLength(3);
    expect(quarantineRequestCount).toBe(1);
    // The main agent is told which tool call produced the hidden data —
    // name and arguments are privileged-authored — in every mode.
    for (const prompt of textPrompts) {
      expect(prompt).toContain('get_emails({"folder":"inbox"})');
    }
    expect(progress).toHaveBeenCalledWith({
      question: "What kind of data is present?",
      options: ["email metadata", "source code", "not determinable"],
      answer: "0",
    });
    // Every model goes through the LLM proxy loopback, attributed to the
    // built-in agent that runs on it.
    expect(createLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: mainAgent.id,
        source: "guardrail:dual_llm",
        userId: undefined,
      }),
    );
    expect(createLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: quarantineAgent.id,
        source: "guardrail:dual_llm",
      }),
    );
    expect(result).toEqual({
      toolCallId: "tool-call-1",
      conversations: [
        {
          role: "assistant",
          content:
            "QUESTION: What kind of data is present?\nOPTIONS:\n0: email metadata\n1: source code\n2: not determinable",
        },
        {
          role: "user",
          content: "Answer: 0 (email metadata)",
        },
        {
          role: "assistant",
          content: "DONE",
        },
      ],
      result: "Safe summary",
    });
  });

  test("does not treat incidental DONE text as a terminal signal", async ({
    makeAgent,
  }) => {
    const mainAgent = await makeAgent(
      buildBuiltInAgentOverrides({
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
        systemPrompt: "main prompt",
        maxRounds: 2,
      }),
    );
    const quarantineAgent = await makeAgent(
      buildBuiltInAgentOverrides({
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
        systemPrompt: "quarantine prompt",
      }),
    );

    vi.spyOn(AgentModel, "getBuiltInAgent").mockImplementation(async (name) => {
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN) {
        return mainAgent;
      }
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE) {
        return quarantineAgent;
      }
      return null;
    });

    let quarantineRequestCount = 0;
    server.use(
      http.post(`${LLM_BASE_URL}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as {
          messages: Array<{ role: string; content: string }>;
        };
        const prompt = lastUserPrompt(body);
        if (isQuarantinePrompt(prompt)) {
          quarantineRequestCount += 1;
          return chatCompletion("0");
        }
        // Incidental "DONE" inside prose is not a terminal signal; the malformed
        // question ends the round and the summary is produced next.
        return prompt.includes("SUMMARY MODE")
          ? chatCompletion("Safe summary")
          : chatCompletion("The task is DONE once we verify the data.");
      }),
    );

    const subagent = await DualLlmSubagent.create({
      dualLlmParams: {
        toolCallId: "tool-call-1",
        userRequest: "summarize this safely",
        toolResult: { raw: "sensitive data" },
        toolName: "get_emails",
      },
      callingAgentId: "agent-1",
      organizationId: "org-1",
    });

    const result = await subagent.processWithMainAgent();

    expect(quarantineRequestCount).toBe(0);
    expect(result).toEqual({
      toolCallId: "tool-call-1",
      conversations: [
        {
          role: "assistant",
          content: "The task is DONE once we verify the data.",
        },
      ],
      result: "Safe summary",
    });
  });

  test("tags provider call failures with the resolved provider and model", async ({
    makeAgent,
  }) => {
    const mainAgent = await makeAgent(
      buildBuiltInAgentOverrides({
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
        systemPrompt: "main prompt",
      }),
    );
    const quarantineAgent = await makeAgent(
      buildBuiltInAgentOverrides({
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
        systemPrompt: "quarantine prompt",
      }),
    );

    vi.spyOn(AgentModel, "getBuiltInAgent").mockImplementation(async (name) => {
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN) {
        return mainAgent;
      }
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE) {
        return quarantineAgent;
      }
      return null;
    });

    // 400 is non-retryable, so the SDK surfaces the provider error directly.
    server.use(
      http.post(`${LLM_BASE_URL}/chat/completions`, () =>
        HttpResponse.json(
          {
            error: {
              code: "1113",
              message:
                "Insufficient balance or no resource package. Please recharge.",
            },
          },
          { status: 400 },
        ),
      ),
    );

    const subagent = await DualLlmSubagent.create({
      dualLlmParams: {
        toolCallId: "tool-call-1",
        userRequest: "summarize this safely",
        toolResult: { raw: "sensitive data" },
        toolName: "get_emails",
      },
      callingAgentId: "agent-1",
      organizationId: "org-1",
    });

    const rejection = await subagent.processWithMainAgent().then(
      () => null,
      (error) => error,
    );

    // The workflow's own resolved provider/model ride on the error so error
    // surfaces attribute the failure correctly (the chat request may run on a
    // different provider than the sanitization subagents).
    expect(rejection).toBeInstanceOf(DualLlmAgentCallError);
    expect(rejection.provider).toBe(MOCK_RESOLVED_LLM.provider);
    expect(rejection.modelName).toBe(MOCK_RESOLVED_LLM.modelName);
    expect(rejection.message).toContain("Insufficient balance");
  });

  test("fails closed with provider attribution when no API key is available", async ({
    makeAgent,
  }) => {
    const mainAgent = await makeAgent(
      buildBuiltInAgentOverrides({
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
        systemPrompt: "main prompt",
      }),
    );
    const quarantineAgent = await makeAgent(
      buildBuiltInAgentOverrides({
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
        systemPrompt: "quarantine prompt",
      }),
    );

    vi.spyOn(AgentModel, "getBuiltInAgent").mockImplementation(async (name) => {
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN) {
        return mainAgent;
      }
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE) {
        return quarantineAgent;
      }
      return null;
    });

    vi.mocked(isApiKeyRequired).mockReturnValue(true);

    const subagent = await DualLlmSubagent.create({
      dualLlmParams: {
        toolCallId: "tool-call-1",
        userRequest: "summarize this safely",
        toolResult: { raw: "sensitive data" },
        toolName: "get_emails",
      },
      callingAgentId: "agent-1",
      organizationId: "org-1",
    });

    const rejection = await subagent.processWithMainAgent().then(
      () => null,
      (error) => error,
    );

    expect(rejection).toBeInstanceOf(DualLlmAgentCallError);
    expect(rejection.provider).toBe(MOCK_RESOLVED_LLM.provider);
    expect(rejection.message).toContain("No anthropic API key is available");
  });

  test("runs on a ChatGPT-subscription credential through the proxy loopback", async ({
    makeAgent,
  }) => {
    const mainAgent = await makeAgent(
      buildBuiltInAgentOverrides({
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
        systemPrompt: "main prompt",
      }),
    );
    const quarantineAgent = await makeAgent(
      buildBuiltInAgentOverrides({
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
        systemPrompt: "quarantine prompt",
      }),
    );

    vi.spyOn(AgentModel, "getBuiltInAgent").mockImplementation(async (name) => {
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN) {
        return mainAgent;
      }
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE) {
        return quarantineAgent;
      }
      return null;
    });

    // Org default resolved to a Codex marker credential. The proxy loopback's
    // openai adapter owns that transport, so the workflow runs on it as-is —
    // no fallback to another key.
    vi.mocked(resolveAgentLlmOrDefault).mockResolvedValue({
      provider: "openai",
      apiKey: "chatgpt-oauth:opaque-marker",
      modelName: "gpt-5.4-mini",
      baseUrl: null,
      chatApiKeyId: "codex-key-row",
    });

    server.use(
      http.post(`${LLM_BASE_URL}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as {
          messages: Array<{ role: string; content: string }>;
        };
        const prompt = lastUserPrompt(body);
        if (isQuarantinePrompt(prompt)) {
          return chatCompletion("0");
        }
        return prompt.includes("SUMMARY MODE")
          ? chatCompletion("Safe summary")
          : chatCompletion("DONE");
      }),
    );

    const subagent = await DualLlmSubagent.create({
      dualLlmParams: {
        toolCallId: "tool-call-1",
        userRequest: "summarize this safely",
        toolResult: { raw: "sensitive data" },
        toolName: "get_emails",
      },
      callingAgentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
    });

    const result = await subagent.processWithMainAgent();

    expect(result.result).toBe("Safe summary");
    // The key row id MUST travel with the credential: codex refresh tokens
    // rotate on redemption, and a loopback call without the row id discards
    // the rotation and permanently burns the stored credential.
    expect(createLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        apiKey: "chatgpt-oauth:opaque-marker",
        modelName: "gpt-5.4-mini",
        source: "guardrail:dual_llm",
        userId: "user-1",
        chatApiKeyId: "codex-key-row",
      }),
    );
  });
});
