// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  BUILT_IN_AGENT_IDS,
  getArchestraToolFullName,
  TOOL_APP_LLM_COMPLETE_SHORT_NAME,
} from "@archestra/shared";
import { APICallError, generateText } from "ai";
import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";
import { type ArchestraContext, executeArchestraTool } from ".";

// Mock only true boundaries: the model call (network to the LLM proxy) and the
// model/key resolution (DB secrets). The reserved-tool dispatch, RBAC, agent
// lookup, jsonMode assembly, and error mapping run for real.
vi.mock("ai", async (importActual) => ({
  ...(await importActual<typeof import("ai")>()),
  generateText: vi.fn(),
}));
vi.mock("@/utils/llm-resolution", async (importActual) => ({
  ...(await importActual<typeof import("@/utils/llm-resolution")>()),
  resolveAgentLlmOrDefault: vi.fn(),
}));

const llmTool = getArchestraToolFullName(TOOL_APP_LLM_COMPLETE_SHORT_NAME);

function archestraError(result: { structuredContent?: unknown }): any {
  return (result.structuredContent as any)?.archestraError;
}

describe("app llm completion", () => {
  let context: ArchestraContext;
  let appRuntimeAgentId: string;

  beforeEach(async ({ makeApp, makeUser, makeMember, makeAgent }) => {
    vi.mocked(generateText).mockReset();
    vi.mocked(resolveAgentLlmOrDefault).mockResolvedValue({
      provider: "anthropic",
      apiKey: "secret",
      modelName: "claude-x",
      baseUrl: null,
    });

    const app = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, app.organizationId, { role: "member" });
    const agent = await makeAgent({
      organizationId: app.organizationId,
      agentType: "agent",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.APP_RUNTIME },
    });
    appRuntimeAgentId = agent.id;
    context = {
      agent: { id: "app-runtime", name: "app" },
      organizationId: app.organizationId,
      userId: user.id,
      appId: app.id,
    };
  });

  test("returns the completion text and runs as the app-runtime agent + viewer", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "a summary" } as any);

    const result = await executeArchestraTool(
      llmTool,
      { prompt: "summarize this" },
      context,
    );

    expect((result as any).structuredContent).toEqual({ text: "a summary" });
    expect((result as any).content[0].text).toBe("a summary");
    // Proxy identity is the org's APP_RUNTIME agent; usage is attributed to the
    // viewer (resolution then feeds createLLMModel({ agentId, userId })).
    expect(vi.mocked(resolveAgentLlmOrDefault)).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: appRuntimeAgentId }),
        organizationId: context.organizationId,
        userId: context.userId,
      }),
    );
    // No JSON directive when jsonMode is off.
    expect(vi.mocked(generateText)).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "summarize this", system: undefined }),
    );
  });

  test("jsonMode steers the model with a JSON directive", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "{}" } as any);

    await executeArchestraTool(
      llmTool,
      { prompt: "extract", system: "be precise", jsonMode: true },
      context,
    );

    const call = vi.mocked(generateText).mock.calls[0][0] as any;
    expect(call.system).toContain("be precise");
    expect(call.system).toContain("JSON");
  });

  test("a usage-limit (429) surfaces archestraError type llm_quota", async () => {
    vi.mocked(generateText).mockRejectedValue(
      new APICallError({
        message: "limit",
        url: "http://proxy",
        requestBodyValues: {},
        statusCode: 429,
      }),
    );

    const result = await executeArchestraTool(
      llmTool,
      { prompt: "x" },
      context,
    );
    expect((result as any).isError).toBe(true);
    expect(archestraError(result).type).toBe("llm_quota");
    expect((result as any)._meta.archestraError.type).toBe("llm_quota");
  });

  test("any other model failure surfaces archestraError type llm_unavailable", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("boom"));

    const result = await executeArchestraTool(
      llmTool,
      { prompt: "x" },
      context,
    );
    expect((result as any).isError).toBe(true);
    expect(archestraError(result).type).toBe("llm_unavailable");
  });

  test("reports llm_unavailable when no provider key is configured", async () => {
    vi.mocked(resolveAgentLlmOrDefault).mockResolvedValue({
      provider: "anthropic",
      apiKey: undefined,
      modelName: "claude-x",
      baseUrl: null,
    });

    const result = await executeArchestraTool(
      llmTool,
      { prompt: "x" },
      context,
    );
    expect(archestraError(result).type).toBe("llm_unavailable");
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  test("an org with no app-runtime agent reports llm_unavailable", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const app = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, app.organizationId, { role: "member" });

    const result = await executeArchestraTool(
      llmTool,
      { prompt: "x" },
      {
        agent: { id: "app-runtime", name: "app" },
        organizationId: app.organizationId,
        userId: user.id,
        appId: app.id,
      },
    );
    expect(archestraError(result).type).toBe("llm_unavailable");
  });
});
