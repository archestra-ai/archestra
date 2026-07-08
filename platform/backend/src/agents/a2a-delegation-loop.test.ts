// biome-ignore-all lint/suspicious/noExplicitAny: test harness drives the AI SDK surface
import { AGENT_TOOL_PREFIX, slugify } from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, vi } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { ToolModel } from "@/models";
import { expect, test } from "@/test";
import type { Agent } from "@/types";
import { executeA2AMessage, MAX_DELEGATION_DEPTH } from "./a2a-executor";

const {
  mockStreamText,
  mockGetChatMcpTools,
  mockCreateLLMModelForAgent,
  mockResolveConversationLlmSelectionForAgent,
  mockBuildSkillCatalogPrompt,
} = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
  mockGetChatMcpTools: vi.fn(),
  mockCreateLLMModelForAgent: vi.fn(),
  mockResolveConversationLlmSelectionForAgent: vi.fn(),
  mockBuildSkillCatalogPrompt: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (...args: unknown[]) => mockStreamText(...args),
    stepCountIs: vi.fn(() => undefined),
  };
});

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

vi.mock("@/skills/skill-catalog-prompt", () => ({
  buildSkillCatalogPrompt: (...args: unknown[]) =>
    mockBuildSkillCatalogPrompt(...args),
}));

function renderableFullStream(): AsyncIterable<{ type: string }> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "text-delta" };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

// Backstop so a regression cannot hang the suite: the harness refuses to
// delegate past this many nested runs. Any assertion that depends on this
// value being reached indicates the product guard did not fire.
const HARNESS_RUNAWAY_CAP = 60;

/**
 * Wires a set of agents into a delegation graph and drives it with a model that
 * issues exactly one delegation call per run (never a repeat, so the per-run
 * repeat ceiling can never trip). Returns what the recursion actually did.
 */
function driveDelegationGraph(
  organizationId: string,
  /** agentId -> the single agent it delegates to */
  nextHop: Record<string, Agent>,
) {
  const runs: string[] = [];
  const toolResults: CallToolResult[] = [];

  mockResolveConversationLlmSelectionForAgent.mockResolvedValue({
    chatApiKeyId: "org-key",
    selectedModel: "gemini-2.5-pro",
    selectedProvider: "gemini",
  });
  mockCreateLLMModelForAgent.mockImplementation(
    async ({ externalAgentId }: any) => {
      // externalAgentId is the delegation chain the executor just built.
      runs.push(externalAgentId);
      return {
        model: { provider: "mock" },
        provider: "gemini",
        apiKeySource: "org",
      };
    },
  );

  // The real delegation tool, reached through the real executeArchestraTool ->
  // handleDelegation. Only the MCP tool *fetch* is stubbed.
  mockGetChatMcpTools.mockImplementation(
    async ({ agentId, delegationChain }: any) => {
      const target = nextHop[agentId];
      if (!target) return {};
      const toolName = `${AGENT_TOOL_PREFIX}${slugify(target.name)}`;
      return {
        [toolName]: {
          execute: (args: any) =>
            executeArchestraTool(toolName, args, {
              agent: { id: agentId, name: agentId },
              agentId,
              organizationId,
              delegationChain,
            } as any),
        },
      };
    },
  );

  mockStreamText.mockImplementation((cfg: any) => {
    const entry = Object.entries(cfg.tools ?? {})[0] as
      | [string, any]
      | undefined;
    const delegated =
      entry && runs.length < HARNESS_RUNAWAY_CAP
        ? entry[1]
            .execute({ message: "ask the other agent for help" })
            .then((r: CallToolResult) => {
              toolResults.push(r);
              return r;
            })
        : Promise.resolve(null);

    return {
      toUIMessageStream: vi.fn((options: any) => {
        const responseMessage = {
          id: `msg-${runs.length}`,
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
        };
        options?.onFinish?.({
          messages: [responseMessage],
          isContinuation: false,
          isAborted: false,
          responseMessage,
          finishReason: "stop",
        });
        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      }),
      fullStream: renderableFullStream(),
      text: delegated.then(() => "ok"),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("stop"),
    };
  });

  return { runs, toolResults };
}

function errorText(result: CallToolResult): string {
  return (result.content[0] as any)?.text ?? "";
}

describe("A2A delegation loop safeguards", () => {
  test("refuses to re-enter an agent already in the delegation chain", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
    makeAgentTool,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const legal = await makeInternalAgent({ name: "Legal Agent" });
    const tech = await makeInternalAgent({ name: "Tech Agent" });

    const toTech = await ToolModel.findOrCreateDelegationTool(tech.id);
    const toLegal = await ToolModel.findOrCreateDelegationTool(legal.id);
    await makeAgentTool(legal.id, toTech.id);
    await makeAgentTool(tech.id, toLegal.id);

    const { runs, toolResults } = driveDelegationGraph(org.id, {
      [legal.id]: tech,
      [tech.id]: legal,
    });

    const result = await executeA2AMessage({
      agentId: legal.id,
      message: "Kick things off",
      organizationId: org.id,
      userId: user.id,
    });

    // Legal ran, delegated to Tech, Tech tried to delegate back and was refused.
    expect(runs).toEqual([legal.id, `${legal.id}:${tech.id}`]);

    // The refusal reached the model as a recoverable tool error, not a crash.
    // Nested executes settle inside-out, so the refusal is the first to land.
    const refusals = toolResults.filter((r) => r.isError);
    expect(refusals).toHaveLength(1);
    expect(errorText(refusals[0])).toMatch(
      /already in the current delegation chain/i,
    );

    expect(result.text).toBe("ok");
  });

  test("refuses to delegate past the depth ceiling", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
    makeAgentTool,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    // A strictly linear chain of distinct agents — no cycle, so only the depth
    // ceiling can stop it. One longer than the ceiling allows.
    const agents: Agent[] = [];
    for (let i = 0; i < MAX_DELEGATION_DEPTH + 1; i++) {
      agents.push(await makeInternalAgent({ name: `Agent ${i}` }));
    }
    const nextHop: Record<string, Agent> = {};
    for (let i = 0; i < agents.length - 1; i++) {
      const tool = await ToolModel.findOrCreateDelegationTool(agents[i + 1].id);
      await makeAgentTool(agents[i].id, tool.id);
      nextHop[agents[i].id] = agents[i + 1];
    }

    const { runs, toolResults } = driveDelegationGraph(org.id, nextHop);

    await executeA2AMessage({
      agentId: agents[0].id,
      message: "Kick things off",
      organizationId: org.id,
      userId: user.id,
    });

    // Exactly MAX_DELEGATION_DEPTH agents ran; the next hop was refused.
    expect(runs.length).toBe(MAX_DELEGATION_DEPTH);
    expect(runs[runs.length - 1].split(":").length).toBe(MAX_DELEGATION_DEPTH);

    const refusals = toolResults.filter((r) => r.isError);
    expect(refusals).toHaveLength(1);
    expect(errorText(refusals[0])).toMatch(/depth limit of 5 reached/i);
  });

  test("a legitimate non-cyclic delegation still executes", async ({
    makeOrganization,
    makeUser,
    makeInternalAgent,
    makeAgentTool,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const planner = await makeInternalAgent({ name: "Planner Agent" });
    const worker = await makeInternalAgent({ name: "Worker Agent" });

    const toWorker = await ToolModel.findOrCreateDelegationTool(worker.id);
    await makeAgentTool(planner.id, toWorker.id);

    // Worker has no delegation tool, so the graph terminates naturally.
    const { runs, toolResults } = driveDelegationGraph(org.id, {
      [planner.id]: worker,
    });

    await executeA2AMessage({
      agentId: planner.id,
      message: "Do the thing",
      organizationId: org.id,
      userId: user.id,
    });

    expect(runs).toEqual([planner.id, `${planner.id}:${worker.id}`]);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].isError).toBe(false);
  });
});
