import { vi } from "vitest";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { AgentModel, LlmProviderApiKeyModelLinkModel } from "@/models";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting } from "@/test/auto-routing";
import type { User } from "@/types";

describe("agents set to Auto", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    config.autoRouting.enabled = true;
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  async function setUpAutoRouting(
    makeLlmProviderApiKey: (
      organizationId: string,
      secretId: string,
      overrides: { provider: "openai" },
    ) => Promise<{ id: string }>,
    makeSecret: () => Promise<{ id: string }>,
  ) {
    const [, normal] = await configureAutoRouting(organizationId);
    const key = await makeLlmProviderApiKey(
      organizationId,
      (await makeSecret()).id,
      { provider: "openai" },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      normal.id,
    ]);
    return { normal, key };
  }

  const update = (agentId: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: `/api/agents/${agentId}`, payload });

  test("an Auto agent stores the organization's normal tier on a key the user may use", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const { normal, key } = await setUpAutoRouting(
      makeLlmProviderApiKey,
      makeSecret,
    );
    const agent = await makeAgent({ organizationId, agentType: "agent" });

    const response = await update(agent.id, { autoRouted: true });

    expect(response.statusCode, response.body).toBe(200);
    expect(await AgentModel.findById(agent.id)).toMatchObject({
      autoRouted: true,
      modelId: normal.id,
      llmApiKeyId: key.id,
      modelPoolId: null,
    });
  });

  test("picking a model leaves Auto", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const { normal, key } = await setUpAutoRouting(
      makeLlmProviderApiKey,
      makeSecret,
    );
    const agent = await makeAgent({ organizationId, agentType: "agent" });
    await update(agent.id, { autoRouted: true });

    const response = await update(agent.id, {
      llmApiKeyId: key.id,
      modelId: normal.id,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await AgentModel.findById(agent.id)).toMatchObject({
      autoRouted: false,
      modelId: normal.id,
    });
  });

  test("Auto is refused while auto routing is off for the organization", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    await setUpAutoRouting(makeLlmProviderApiKey, makeSecret);
    await AutoRoutingSettingsModel.update(organizationId, { enabled: false });
    const agent = await makeAgent({ organizationId, agentType: "agent" });

    const response = await update(agent.id, { autoRouted: true });

    expect(response.statusCode).toBe(400);
    expect((await AgentModel.findById(agent.id))?.autoRouted).toBe(false);
  });
});
