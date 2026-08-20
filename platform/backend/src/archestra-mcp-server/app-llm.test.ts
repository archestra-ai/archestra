// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  BUILT_IN_AGENT_IDS,
  getArchestraToolFullName,
  TOOL_APP_LLM_COMPLETE_SHORT_NAME,
} from "@archestra/shared";
import { APICallError, generateText } from "ai";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { LlmProviderApiKeyModelLinkModel, ModelModel } from "@/models";
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

/** A model row linked to its API key, as a provider sync would leave it. */
async function makeSyncedModel(
  provider: "ollama" | "vllm",
  modelId: string,
  apiKeyId: string,
) {
  const model = await ModelModel.create({
    externalId: `${provider}/${modelId}`,
    provider,
    modelId,
    contextLength: 100_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: false,
    lastSyncedAt: new Date(),
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(apiKeyId, [
    model.id,
  ]);
  return model;
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

  // Every non-quota failure used to read "The LLM completion could not be
  // produced.", so an app author could not tell a prompt too long for the model
  // from a revoked credential from an outage — the cause reached only a server
  // log they cannot read.
  test("a rejected request tells the app what the provider rejected", async () => {
    vi.mocked(generateText).mockRejectedValue(
      new APICallError({
        message: "Bad Request",
        url: "http://proxy/v1/messages",
        requestBodyValues: { prompt: "x" },
        statusCode: 400,
        responseBody: "input length exceeds the context window",
      }),
    );

    const result = await executeArchestraTool(
      llmTool,
      { prompt: "x" },
      context,
    );
    const { type, message } = archestraError(result);
    expect(type).toBe("llm_unavailable");
    expect(message).toContain("prompt may be too long");
    expect(message).toContain("input length exceeds the context window");
    // The platform's own routing is not the app's business.
    expect(message).not.toContain("http://proxy");
  });

  test("a provider outage reads as one, not as a generic failure", async () => {
    vi.mocked(generateText).mockRejectedValue(
      new APICallError({
        message: "Service Unavailable",
        url: "http://proxy/v1/messages",
        requestBodyValues: {},
        statusCode: 503,
      }),
    );

    const result = await executeArchestraTool(
      llmTool,
      { prompt: "x" },
      context,
    );
    expect(archestraError(result).message).toContain("unavailable right now");
  });

  test("a failure that describes itself no better keeps the generic message", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("boom"));

    const result = await executeArchestraTool(
      llmTool,
      { prompt: "x" },
      context,
    );
    expect(archestraError(result).message).toBe(
      "The LLM completion could not be produced.",
    );
    // The thrown error's own text is not passed through: it is not shaped for
    // an app author and can carry the platform's internals.
    expect(archestraError(result).message).not.toContain("boom");
  });

  test("a caller that gave up cancels the model call instead of reporting a provider failure", async () => {
    const controller = new AbortController();
    vi.mocked(generateText).mockImplementation(async () => {
      // The caller disconnects while the model is thinking; the AI SDK then
      // rejects with the abort, as the real call would.
      controller.abort();
      throw new DOMException("This operation was aborted", "AbortError");
    });

    const result = await executeArchestraTool(
      llmTool,
      { prompt: "x" },
      { ...context, abortSignal: controller.signal },
    );

    // The signal reaches the model call, so the completion actually stops.
    expect(vi.mocked(generateText)).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal }),
    );
    expect((result as any).isError).toBe(true);
    expect((result as any).content[0].text).toContain("cancelled");
    // Not a provider failure: no llm_unavailable envelope for the app to
    // branch on.
    expect(archestraError(result)).toBeUndefined();
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

  test("runs on the app-runtime agent's configured model, not the organization default", async ({
    makeApp,
    makeUser,
    makeMember,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // An app completion has no calling agent to inherit from — it can be
    // launched from any chat, or standalone from /a/:slug — so the App Runtime
    // LLM Agent's own model is the only control an admin has over it. Pin that:
    // if it stopped winning over the organization default, a self-hosted org
    // would have no way to route app completions at all.
    const { resolveAgentLlmOrDefault: realResolve } = await vi.importActual<
      typeof import("@/utils/llm-resolution")
    >("@/utils/llm-resolution");
    vi.mocked(resolveAgentLlmOrDefault).mockImplementation(realResolve);

    const app = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, app.organizationId, { role: "member" });

    const orgSecret = await makeSecret({ secret: { apiKey: "ollama-key" } });
    const orgKey = await makeLlmProviderApiKey(
      app.organizationId,
      orgSecret.id,
      { provider: "ollama", scope: "org", name: "Ollama" },
    );
    const orgModel = await makeSyncedModel("ollama", "llama3.1", orgKey.id);
    await db
      .update(schema.organizationsTable)
      .set({ defaultModelId: orgModel.id, defaultLlmApiKeyId: orgKey.id })
      .where(eq(schema.organizationsTable.id, app.organizationId));

    const appSecret = await makeSecret({ secret: { apiKey: "vllm-key" } });
    const appKey = await makeLlmProviderApiKey(
      app.organizationId,
      appSecret.id,
      { provider: "vllm", scope: "org", name: "vLLM" },
    );
    const appModel = await makeSyncedModel("vllm", "qwen3-32b", appKey.id);
    await makeAgent({
      organizationId: app.organizationId,
      agentType: "agent",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.APP_RUNTIME },
      llmApiKeyId: appKey.id,
      modelId: appModel.id,
    });

    vi.mocked(generateText).mockResolvedValue({ text: "ok" } as any);

    await executeArchestraTool(
      llmTool,
      { prompt: "summarize this" },
      {
        agent: { id: "app-runtime", name: "app" },
        organizationId: app.organizationId,
        userId: user.id,
        appId: app.id,
      },
    );

    expect(vi.mocked(generateText).mock.calls[0][0].model).toMatchObject({
      modelId: "qwen3-32b",
    });
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
