import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { MemberModel, ModelModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("bootstrap route", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organization.id, { role: "member" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      const req = request as typeof request & {
        user: User;
        organizationId: string;
      };
      req.user = user;
      req.organizationId = organization.id;
    });

    const [
      bootstrap,
      config,
      user_,
      organization_,
      resourcePermissions,
      agent,
    ] = await Promise.all([
      import("./bootstrap"),
      import("./config"),
      import("./user"),
      import("./organization"),
      import("./resource-permission/resource-permission.routes"),
      import("./agent"),
    ]);
    await app.register(bootstrap.default);
    await app.register(config.default);
    await app.register(user_.default);
    await app.register(organization_.default);
    await app.register(resourcePermissions.default);
    await app.register(agent.default);
  });

  afterEach(async () => {
    await app.close();
  });

  // The frontend seeds each part into the query its own endpoint feeds, so the
  // parts must be exactly what those endpoints return.
  test("returns the same data as the individual endpoints", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // Non-empty member defaults, so their parts are compared on real values.
    const agent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
    });
    await MemberModel.setDefaultAgent(user.id, organizationId, agent.id);
    const secret = await makeSecret();
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });
    const model = await ModelModel.create({
      provider: "openai",
      modelId: "gpt-test",
      externalId: "gpt-test",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    await MemberModel.setDefaultModelSelection({
      userId: user.id,
      organizationId,
      modelId: model.id,
      apiKeyId: apiKey.id,
    });

    const bootstrap = await get("/api/bootstrap");

    expect(bootstrap).toEqual({
      permissions: await get("/api/user/permissions"),
      scopedCapabilities: await get("/api/resource-permissions"),
      organization: await get("/api/organization"),
      config: await get("/api/config"),
      publicConfig: await get("/api/config/public"),
      appearance: await get("/api/organization/appearance-settings"),
      memberDefaultAgent: await get("/api/members/default-agent"),
      memberDefaultModel: await get("/api/members/default-model"),
    });
    expect(Object.keys(bootstrap.permissions).length).toBeGreaterThan(0);
    expect(bootstrap.memberDefaultAgent.defaultAgentId).toBe(agent.id);
    expect(bootstrap.memberDefaultModel).toEqual({
      modelId: model.id,
      chatApiKeyId: apiKey.id,
    });
  });

  async function get(url: string) {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
});
