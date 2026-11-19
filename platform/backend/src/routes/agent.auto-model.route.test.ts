import { BUILT_IN_AGENT_IDS, buildCustomAgentRuntime } from "@archestra/shared";
import { vi } from "vitest";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import AgentModel from "@/models/agent";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import { beforeEach, describe, expect, test } from "@/test";
import {
  autoRouterId,
  configureAutoRouting,
  ensureAutoRouter,
} from "@/test/auto-routing";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./agent";

vi.mock("@/observability");

const runtime = buildCustomAgentRuntime({ image: "example.test/worker:v1" });

/**
 * An agent on an auto router has no model, key or pool of its own; picking one
 * leaves the router. Agent Runtime and built-in agents never run on one.
 */
describe("agent routes - auto router", () => {
  const ctx = useRouteTestApp(routes);

  beforeEach(async ({ makeMember }) => {
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  const create = (payload: object) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { agentType: "agent", name: "Agent", ...payload },
    });
  const update = (id: string, payload: object) =>
    ctx.app.inject({ method: "PUT", url: `/api/agents/${id}`, payload });

  test("an agent on auto drops its own model, and picking a key and model leaves auto", async () => {
    const [, normal] = await configureAutoRouting(ctx.organizationId);
    const routerId = await autoRouterId(ctx.organizationId);
    const key = await LlmProviderApiKeyModel.findOrganizationWideKey(
      ctx.organizationId,
      "openai",
    );
    if (!key) throw new Error("tier key missing");

    const created = await create({
      autoRouterId: routerId,
      llmApiKeyId: key.id,
      modelId: normal.id,
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({
      autoRouterId: routerId,
      llmApiKeyId: null,
      modelId: null,
      modelPoolId: null,
    });

    const picked = await update(created.json().id, {
      llmApiKeyId: key.id,
      modelId: normal.id,
    });
    expect(picked.statusCode, picked.body).toBe(200);
    expect(picked.json()).toMatchObject({
      autoRouterId: null,
      llmApiKeyId: key.id,
      modelId: normal.id,
    });
  });

  test("an Agent Runtime agent cannot be put on auto, and an agent leaves auto when it gets a runtime", async () => {
    const routerId = (await ensureAutoRouter(ctx.organizationId)).id;
    const refused = await create({ autoRouterId: routerId, runtime });
    expect(refused.statusCode).toBe(400);

    const created = await create({ autoRouterId: routerId });
    expect(created.json().autoRouterId).toBe(routerId);
    const withRuntime = await update(created.json().id, { runtime });
    expect(withRuntime.statusCode, withRuntime.body).toBe(200);
    expect(
      (await AgentModel.findById(created.json().id))?.autoRouterId,
    ).toBeNull();
  });

  test("a built-in agent cannot be put on auto", async ({ makeAgent }) => {
    const builtIn = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
    });
    const routerId = (await ensureAutoRouter(ctx.organizationId)).id;
    const response = await update(builtIn.id, { autoRouterId: routerId });
    expect(response.statusCode).toBe(400);
    expect((await AgentModel.findById(builtIn.id))?.autoRouterId).toBeNull();
  });

  test("a router of another organization, or one that no longer exists, is refused", async ({
    makeOrganization,
  }) => {
    const other = await makeOrganization();
    const foreign = await ensureAutoRouter(other.id);

    const refused = await create({ autoRouterId: foreign.id });
    const unknown = await create({ autoRouterId: crypto.randomUUID() });

    expect(refused.statusCode, refused.body).toBe(400);
    expect(unknown.statusCode, unknown.body).toBe(400);
  });
});
