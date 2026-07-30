// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  BUILT_IN_AGENT_IDS,
  getArchestraToolFullName,
  TOOL_ADVISOR_SHORT_NAME,
} from "@archestra/shared";
import { APICallError, generateText } from "ai";
import { vi } from "vitest";
import { ModelModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";
import { type ArchestraContext, executeArchestraTool } from ".";

// Mock only true boundaries: the model call (network, via the LLM proxy) and
// model/key resolution (DB secrets). Dispatch, RBAC, the built-in agent lookup,
// the unconfigured-advisor refusal, and error mapping all run for real.
vi.mock("ai", async (importActual) => ({
  ...(await importActual<typeof import("ai")>()),
  generateText: vi.fn(),
}));
vi.mock("@/utils/llm-resolution", async (importActual) => ({
  ...(await importActual<typeof import("@/utils/llm-resolution")>()),
  resolveAgentLlmOrDefault: vi.fn(),
}));

const advisorTool = getArchestraToolFullName(TOOL_ADVISOR_SHORT_NAME);

function archestraError(result: { structuredContent?: unknown }): any {
  return (result.structuredContent as any)?.archestraError;
}

describe("advisor consultation", () => {
  let context: ArchestraContext;
  let organizationId: string;
  let advisorModelId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.mocked(generateText).mockReset();
    vi.mocked(resolveAgentLlmOrDefault).mockResolvedValue({
      provider: "anthropic",
      apiKey: "secret",
      modelName: "strong-model",
      baseUrl: null,
    });

    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: "member" });

    const model = await ModelModel.create({
      externalId: "anthropic/strong-model",
      provider: "anthropic",
      modelId: "strong-model",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    advisorModelId = model.id;

    context = {
      agent: { id: "caller", name: "caller" },
      organizationId,
      userId: user.id,
    };
  });

  async function makeAdvisorAgent(
    makeAgent: any,
    overrides: Record<string, unknown> = {},
  ) {
    return makeAgent({
      organizationId,
      agentType: "agent",
      systemPrompt: "You are a reviewer.",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
      ...overrides,
    });
  }

  test("returns guidance from the advisor agent's configured model", async ({
    makeAgent,
  }) => {
    const agent = await makeAdvisorAgent(makeAgent, {
      modelId: advisorModelId,
    });
    vi.mocked(generateText).mockResolvedValue({ text: "Do B, not A." } as any);

    const result = await executeArchestraTool(
      advisorTool,
      { question: "A or B?" },
      context,
    );

    expect((result as any).structuredContent).toEqual({
      guidance: "Do B, not A.",
    });
    expect((result as any).content[0].text).toBe("Do B, not A.");
    // Runs as the ADVISOR agent, so the model and credential are the org's
    // configured advisor rather than whatever the caller happens to be using.
    expect(vi.mocked(resolveAgentLlmOrDefault)).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: agent.id }),
        organizationId,
        userId: context.userId,
      }),
    );
  });

  test("refuses when no advisor model is configured, without calling a model", async ({
    makeAgent,
  }) => {
    // modelId unset: resolution would fall back to the org default, which is
    // usually the model already asking. Advising yourself is not a second
    // opinion, so the consultation is refused instead.
    await makeAdvisorAgent(makeAgent);

    const result = await executeArchestraTool(
      advisorTool,
      { question: "A or B?" },
      context,
    );

    expect((result as any).isError).toBe(true);
    expect(archestraError(result as any).type).toBe("advisor_unavailable");
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  test("refuses when the organization has no advisor agent", async () => {
    const result = await executeArchestraTool(
      advisorTool,
      { question: "A or B?" },
      context,
    );

    expect((result as any).isError).toBe(true);
    expect(archestraError(result as any).type).toBe("advisor_unavailable");
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  test("refuses when resolution falls back off the configured model", async ({
    makeAgent,
  }) => {
    await makeAdvisorAgent(makeAgent, { modelId: advisorModelId });
    // What a deleted credential row produces: resolution abandons the agent's
    // own model and returns the org default — which is usually the model that
    // is asking. Answering with it would be self-advising in disguise.
    vi.mocked(resolveAgentLlmOrDefault).mockResolvedValue({
      provider: "anthropic",
      apiKey: "secret",
      modelName: "the-callers-own-model",
      baseUrl: null,
    });

    const result = await executeArchestraTool(
      advisorTool,
      { question: "A or B?" },
      context,
    );

    expect(archestraError(result as any).type).toBe("advisor_unavailable");
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  test("refuses when the configured model has no usable credential", async ({
    makeAgent,
  }) => {
    await makeAdvisorAgent(makeAgent, { modelId: advisorModelId });
    vi.mocked(resolveAgentLlmOrDefault).mockResolvedValue({
      provider: "anthropic",
      apiKey: undefined,
      modelName: "strong-model",
      baseUrl: null,
    });

    const result = await executeArchestraTool(
      advisorTool,
      { question: "A or B?" },
      context,
    );

    expect(archestraError(result as any).type).toBe("advisor_unavailable");
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  test("passes the question and context separately, and offers the advisor no tools", async ({
    makeAgent,
  }) => {
    await makeAdvisorAgent(makeAgent, { modelId: advisorModelId });
    vi.mocked(generateText).mockResolvedValue({ text: "ok" } as any);

    await executeArchestraTool(
      advisorTool,
      { question: "A or B?", context: "I already tried A twice." },
      context,
    );

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as any;
    // Pinned exactly: the labels are what stop a long context block from
    // reading as the question itself.
    expect(call.prompt).toBe(
      "Question:\nA or B?\n\nContext from the model asking:\nI already tried A twice.",
    );
    // The advisor's persona comes from the agent an admin can edit.
    expect(call.system).toBe("You are a reviewer.");
    // An advisor that can consult an advisor turns one decision into a
    // billed chain of them.
    expect(call.tools).toBeUndefined();
    expect(call.maxOutputTokens).toBe(2048);
  });

  // 429 is an upstream rate limit, 402 the platform's own cost-limit block.
  // Both mean the same thing to the caller: back off and continue unadvised.
  test("maps rate-limit and cost-limit failures to a quota error", async ({
    makeAgent,
  }) => {
    await makeAdvisorAgent(makeAgent, { modelId: advisorModelId });

    for (const statusCode of [429, 402]) {
      vi.mocked(generateText).mockRejectedValue(
        new APICallError({
          message: "limited",
          url: "https://internal.proxy/v1",
          requestBodyValues: {},
          statusCode,
        }),
      );

      const result = await executeArchestraTool(
        advisorTool,
        { question: "A or B?" },
        context,
      );

      expect(archestraError(result as any).type).toBe("advisor_quota");
    }
  });

  test("reports a provider failure without leaking the proxy endpoint", async ({
    makeAgent,
  }) => {
    await makeAdvisorAgent(makeAgent, { modelId: advisorModelId });
    vi.mocked(generateText).mockRejectedValue(
      new APICallError({
        message: "bad request to https://internal.proxy/v1",
        url: "https://internal.proxy/v1",
        requestBodyValues: {},
        statusCode: 400,
        responseBody: "context length exceeded",
      }),
    );

    const result = await executeArchestraTool(
      advisorTool,
      { question: "A or B?" },
      context,
    );

    const error = archestraError(result as any);
    expect(error.type).toBe("advisor_unavailable");
    expect(error.message).toContain("context length exceeded");
    // How Archestra routes its LLM calls is not the caller's business.
    expect(error.message).not.toContain("internal.proxy");
  });
});
