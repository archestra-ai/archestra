import { PLAYWRIGHT_MCP_CATALOG_ID, RouteId } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import {
  LlmProviderApiKeyModelLinkModel,
  MemberModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("new-chat bootstrap route", () => {
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

    const [bootstrap, agent, agentTool, keys, models] = await Promise.all([
      import("./bootstrap"),
      import("./agent"),
      import("./agent-tool"),
      import("./llm-provider-api-keys"),
      import("./llm-provider-models"),
    ]);
    await app.register(bootstrap.default);
    await app.register(agent.default);
    await app.register(agentTool.default);
    await app.register(keys.default);
    await app.register(models.default);
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
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(apiKey.id, [
      model.id,
    ]);
    const orgDefault = await makeAgent({
      organizationId,
      agentType: "agent",
      llmApiKeyId: apiKey.id,
      modelId: model.id,
      suggestedPrompts: [
        { summaryTitle: "Summarize", prompt: "Summarize this document." },
      ],
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: orgDefault.id,
    });

    const bootstrap = await get("/api/bootstrap/new-chat");

    expect(bootstrap).toEqual({
      roster: await get("/api/agents/chat-roster?bootstrap=true"),
      apiKeys: await get("/api/llm-provider-api-keys"),
      availableApiKeys: await get("/api/llm-provider-api-keys/available"),
      models: await get("/api/llm-models/available"),
      agent: {
        id: orgDefault.id,
        detail: await get(`/api/agents/${orgDefault.id}`),
        delegations: await get(`/api/agents/${orgDefault.id}/delegations`),
        credentialReadiness: await get(
          `/api/agents/credential-readiness?ids=${orgDefault.id}`,
        ),
        browserTools: await get(
          `/api/agents/${orgDefault.id}/tools?catalogId=${PLAYWRIGHT_MCP_CATALOG_ID}`,
        ),
        defaultSuggestedPrompts: null,
        keyModels: await get(`/api/llm-models/available?apiKeyId=${apiKey.id}`),
      },
    });
    expect(bootstrap.models).toHaveLength(1);
    expect(bootstrap.agent.detail.suggestedPrompts).toHaveLength(1);
  });

  test("an agent without prompts carries the platform's default prompts", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, agentType: "agent" });
    await MemberModel.setDefaultAgent(user.id, organizationId, agent.id);

    const bootstrap = await get("/api/bootstrap/new-chat");

    expect(bootstrap.agent.id).toBe(agent.id);
    expect(bootstrap.agent.defaultSuggestedPrompts).toEqual(
      await get(`/api/agents/${agent.id}/default-suggested-prompts`),
    );
    expect(bootstrap.agent.keyModels).toBeNull();
  });

  test("starts on the member's default, then the organization's, then the caller's own agent", async ({
    makeAgent,
  }) => {
    const [own, memberDefault, orgDefault] = await Promise.all([
      makeAgent({
        organizationId,
        agentType: "agent",
        authorId: user.id,
        access: "personal",
      }),
      makeAgent({ organizationId, agentType: "agent" }),
      makeAgent({ organizationId, agentType: "agent" }),
    ]);
    expect((await get("/api/bootstrap/new-chat")).agent.id).toBe(own.id);

    await OrganizationModel.patch(organizationId, {
      defaultAgentId: orgDefault.id,
    });
    expect((await get("/api/bootstrap/new-chat")).agent.id).toBe(orgDefault.id);

    await MemberModel.setDefaultAgent(
      user.id,
      organizationId,
      memberDefault.id,
    );
    expect((await get("/api/bootstrap/new-chat")).agent.id).toBe(
      memberDefault.id,
    );
  });

  test("never starts on an agent the caller cannot use", async ({
    makeAgent,
    makeUser,
  }) => {
    const owner = await makeUser();
    const hidden = await makeAgent({
      organizationId,
      agentType: "agent",
      authorId: owner.id,
      access: "personal",
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: hidden.id,
    });

    const bootstrap = await get("/api/bootstrap/new-chat");

    expect(
      bootstrap.roster.map((agent: { id: string }) => agent.id),
    ).not.toContain(hidden.id);
    expect(bootstrap.agent?.id).not.toBe(hidden.id);
  });

  test("leaves out the usable keys exactly when their own endpoint refuses the caller", async ({
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    // The bundle's gate is the endpoint's own route check.
    expect(
      requiredEndpointPermissionsMap[RouteId.GetAvailableLlmProviderApiKeys],
    ).toEqual({ llmProviderApiKey: ["read"] });
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read"], chat: ["read"] },
    });
    const withoutKeys = await makeUser();
    await makeMember(withoutKeys.id, organizationId, { role: role.role });

    const asMember = await get("/api/bootstrap/new-chat");
    user = withoutKeys;
    const asRestricted = await get("/api/bootstrap/new-chat");

    expect(asMember.availableApiKeys).toEqual(expect.any(Array));
    expect(asRestricted.availableApiKeys).toBeNull();
  });

  async function get(url: string) {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
});
