import { BUILT_IN_AGENT_IDS } from "@shared";
import { generateObject, generateText } from "ai";
import { vi } from "vitest";
import AgentModel from "@/models/agent";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { resolveSmartDefaultLlm } from "@/utils/llm-resolution";
import { DualLlmSubagent } from "./dual-llm";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("@/clients/llm-client", () => ({
  createDirectLLMModel: vi.fn(() => "mocked-model"),
  detectProviderFromModel: vi.fn(() => "openai"),
  resolveProviderApiKey: vi.fn(),
}));

vi.mock("@/utils/llm-resolution", () => ({
  resolveSmartDefaultLlm: vi.fn(),
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

function makeBuiltInAgent(params: {
  name: (typeof BUILT_IN_AGENT_IDS)[keyof typeof BUILT_IN_AGENT_IDS];
  systemPrompt: string;
  maxRounds?: number;
}): Agent {
  return {
    id: `${params.name}-id`,
    organizationId: "org-1",
    authorId: null,
    scope: "org",
    name: params.name,
    isDefault: false,
    considerContextUntrusted: false,
    agentType: "agent",
    systemPrompt: params.systemPrompt,
    description: null,
    icon: null,
    incomingEmailEnabled: false,
    incomingEmailSecurityMode: "private",
    incomingEmailAllowedDomain: null,
    llmApiKeyId: null,
    llmModel: null,
    identityProviderId: null,
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
              autoConfigureOnToolAssignment: false,
            },
    builtIn: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    teams: [],
    tools: [],
    labels: [],
    knowledgeBaseIds: [],
    connectorIds: [],
    suggestedPrompts: [],
    authorName: null,
  };
}

describe("DualLlmSubagent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveSmartDefaultLlm).mockResolvedValue(MOCK_RESOLVED_LLM);
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

  test("uses built-in agents to run the question/answer/summary flow", async () => {
    const mainAgent = makeBuiltInAgent({
      name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
      systemPrompt: "main prompt",
      maxRounds: 2,
    });
    const quarantineAgent = makeBuiltInAgent({
      name: BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
      systemPrompt: "quarantine prompt",
    });

    vi.spyOn(AgentModel, "getBuiltInAgent").mockImplementation(async (name) => {
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN) {
        return mainAgent;
      }
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE) {
        return quarantineAgent;
      }
      return null;
    });

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "QUESTION: What kind of data is present?\nOPTIONS:\n0: email metadata\n1: source code\n2: not determinable",
      } as never)
      .mockResolvedValueOnce({ text: "DONE" } as never)
      .mockResolvedValueOnce({ text: "Safe summary" } as never);

    vi.mocked(generateObject).mockResolvedValue({
      object: { answer: 0 },
    } as never);

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

    expect(generateText).toHaveBeenCalledTimes(3);
    expect(generateObject).toHaveBeenCalledTimes(1);
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

  test("does not treat incidental DONE text as a terminal signal", async () => {
    const mainAgent = makeBuiltInAgent({
      name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
      systemPrompt: "main prompt",
      maxRounds: 2,
    });
    const quarantineAgent = makeBuiltInAgent({
      name: BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
      systemPrompt: "quarantine prompt",
    });

    vi.spyOn(AgentModel, "getBuiltInAgent").mockImplementation(async (name) => {
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN) {
        return mainAgent;
      }
      if (name === BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE) {
        return quarantineAgent;
      }
      return null;
    });

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "The task is DONE once we verify the data.",
      } as never)
      .mockResolvedValueOnce({ text: "Safe summary" } as never);

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

    expect(generateObject).not.toHaveBeenCalled();
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
