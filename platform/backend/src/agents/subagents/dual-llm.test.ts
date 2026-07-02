import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import AgentModel from "@/models/agent";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { InsertAgent } from "@/types";
import { resolveBestAvailableLlm } from "@/utils/llm-resolution";
import { DualLlmSubagent } from "./dual-llm";

// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper (per-test MSW server), not a React hook
const server = useMswServer();

// Boundary mock: the real `ai` SDK runs generateText/generateObject and MSW
// serves the provider wire responses. The only internal seam we keep is the
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
    createDirectLLMModel: vi.fn(() => model),
    resolveProviderApiKey: vi.fn(),
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

// generateObject requests a json_schema response_format; generateText does not.
function isObjectRequest(body: {
  response_format?: { type?: string };
}): boolean {
  return body.response_format?.type === "json_schema";
}

vi.mock("@/utils/llm-resolution", () => ({
  resolveBestAvailableLlm: vi.fn(),
  resolveConfiguredAgentLlm: vi.fn(),
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
    vi.mocked(resolveBestAvailableLlm).mockResolvedValue(MOCK_RESOLVED_LLM);
  });

  test("throws when dual LLM built-in agents are missing", async () => {
    vi.spyOn(AgentModel, "getBuiltInAgent").mockResolvedValue(null);

    await expect(
      DualLlmSubagent.create({
        dualLlmParams: {
          toolCallId: "tool-call-1",
          userRequest: "summarize this",
          toolResult: { raw: "data" },
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
    let objectRequestCount = 0;
    server.use(
      http.post(`${LLM_BASE_URL}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as {
          messages: Array<{ role: string; content: string }>;
          response_format?: { type?: string };
        };

        // Quarantine agent's answer runs through generateObject.
        if (isObjectRequest(body)) {
          objectRequestCount += 1;
          return chatCompletion(JSON.stringify({ answer: 0 }));
        }

        const prompt = lastUserPrompt(body);
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
      },
      callingAgentId: "agent-1",
      organizationId: "org-1",
    });

    const progress = vi.fn();
    const result = await subagent.processWithMainAgent(progress);

    // Three text generations (two question rounds + final summary) and one
    // structured answer from the quarantine agent.
    expect(textPrompts).toHaveLength(3);
    expect(objectRequestCount).toBe(1);
    expect(progress).toHaveBeenCalledWith({
      question: "What kind of data is present?",
      options: ["email metadata", "source code", "not determinable"],
      answer: "0",
    });
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

    let objectRequestCount = 0;
    const textPrompts: string[] = [];
    server.use(
      http.post(`${LLM_BASE_URL}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as {
          messages: Array<{ role: string; content: string }>;
          response_format?: { type?: string };
        };
        if (isObjectRequest(body)) {
          objectRequestCount += 1;
          return chatCompletion(JSON.stringify({ answer: 0 }));
        }
        const prompt = lastUserPrompt(body);
        textPrompts.push(prompt);
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
      },
      callingAgentId: "agent-1",
      organizationId: "org-1",
    });

    const result = await subagent.processWithMainAgent();

    expect(objectRequestCount).toBe(0);
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
});
