import { ADMIN_ROLE_NAME } from "@archestra/shared";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ConnectionSetupModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent, ConnectionSetupClientId, User } from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("GET /api/connected-clients/adoption", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;
  let gateway: Agent;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeUser({ name: "Admin" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    gateway = await makeAgent({
      organizationId,
      name: "Engineering tools",
      agentType: "mcp_gateway",
    });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = admin;
    });
    const { default: routes } = await import("./connected-client.routes");
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  const getAdoption = async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/connected-clients/adoption",
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      activeDays: number;
      lookbackDays: number;
      members: {
        userId: string;
        status: string;
        setUpAgents: string[];
        gatewayLastSeenAt: string | null;
        llmLastSeenAt: string | null;
        llmAgents: string[];
      }[];
    };
  };

  const memberById = async (userId: string) =>
    (await getAdoption()).members.find((m) => m.userId === userId);

  test("a member with no setup and no traffic has not connected", async ({
    makeUser,
    makeMember,
  }) => {
    const ada = await makeUser({ name: "Ada" });
    await makeMember(ada.id, organizationId);

    const body = await getAdoption();

    expect(body).toMatchObject({ activeDays: 7, lookbackDays: 30 });
    expect(body.members.find((m) => m.userId === ada.id)).toMatchObject({
      status: "notConnected",
      setUpAgents: [],
      gatewayLastSeenAt: null,
      llmLastSeenAt: null,
    });
  });

  test("a redeemed setup with no traffic is set up, not active", async ({
    makeUser,
    makeMember,
  }) => {
    const ada = await makeUser({ name: "Ada" });
    await makeMember(ada.id, organizationId);
    await redeem(ada.id, "codex");

    expect(await memberById(ada.id)).toMatchObject({
      status: "setUp",
      setUpAgents: ["codex"],
    });
  });

  test("recent gateway calls from a signed-in agent make a member active", async ({
    makeUser,
    makeMember,
  }) => {
    const ada = await makeUser({ name: "Ada" });
    await makeMember(ada.id, organizationId);
    await redeem(ada.id, "claude-code");
    await gatewayCall(ada.id, { authMethod: "oauth", daysAgo: 1 });

    expect(await memberById(ada.id)).toMatchObject({
      status: "active",
      gatewayLastSeenAt: expect.any(String),
    });
  });

  test("only OAuth gateway calls count, not the built-in chat's", async ({
    makeUser,
    makeMember,
  }) => {
    const ada = await makeUser({ name: "Ada" });
    await makeMember(ada.id, organizationId);
    await gatewayCall(ada.id, { authMethod: "user_token", daysAgo: 1 });

    expect(await memberById(ada.id)).toMatchObject({
      status: "notConnected",
      gatewayLastSeenAt: null,
    });
  });

  test("traffic older than a week is inactive, older than the lookback is ignored", async ({
    makeUser,
    makeMember,
    makeInteraction,
  }) => {
    const ada = await makeUser({ name: "Ada" });
    const bob = await makeUser({ name: "Bob" });
    await makeMember(ada.id, organizationId);
    await makeMember(bob.id, organizationId);
    await makeInteraction(gateway.id, {
      userId: ada.id,
      source: "api",
      externalAgentId: "openai_codex",
      createdAt: new Date(Date.now() - 10 * DAY_MS),
    });
    await gatewayCall(bob.id, { authMethod: "oauth", daysAgo: 40 });

    expect(await memberById(ada.id)).toMatchObject({
      status: "inactive",
      llmAgents: ["openai_codex"],
    });
    expect(await memberById(bob.id)).toMatchObject({
      status: "notConnected",
      gatewayLastSeenAt: null,
    });
  });

  test("LLM proxy calls are credited to the passthrough key's owner", async ({
    makeUser,
    makeMember,
    makeInteraction,
    makeVirtualApiKey,
  }) => {
    const ada = await makeUser({ name: "Ada" });
    const bob = await makeUser({ name: "Bob" });
    await makeMember(ada.id, organizationId);
    await makeMember(bob.id, organizationId);
    const adaKey = await makeVirtualApiKey(organizationId, {
      authorId: ada.id,
    });
    // The user header names Bob, but Ada's key authenticated the call.
    await makeInteraction(gateway.id, {
      userId: bob.id,
      passthroughVirtualKeyId: adaKey.id,
      source: "api",
      externalAgentId: "anthropic_claude_code",
    });

    expect(await memberById(ada.id)).toMatchObject({ status: "active" });
    expect(await memberById(bob.id)).toMatchObject({
      status: "notConnected",
    });
  });

  test("built-in chat LLM calls do not count as agent traffic", async ({
    makeUser,
    makeMember,
    makeInteraction,
  }) => {
    const ada = await makeUser({ name: "Ada" });
    await makeMember(ada.id, organizationId);
    await makeInteraction(gateway.id, { userId: ada.id, source: "chat" });

    expect(await memberById(ada.id)).toMatchObject({
      status: "notConnected",
    });
  });

  test("traffic from another organization's agents is not counted", async ({
    makeUser,
    makeMember,
    makeOrganization,
    makeAgent,
  }) => {
    const ada = await makeUser({ name: "Ada" });
    await makeMember(ada.id, organizationId);
    const otherOrg = await makeOrganization();
    const otherGateway = await makeAgent({
      organizationId: otherOrg.id,
      agentType: "mcp_gateway",
    });
    await gatewayCall(ada.id, {
      authMethod: "oauth",
      daysAgo: 1,
      agentId: otherGateway.id,
    });

    expect(await memberById(ada.id)).toMatchObject({
      status: "notConnected",
    });
  });

  async function redeem(userId: string, clientId: ConnectionSetupClientId) {
    const { rawToken } = await ConnectionSetupModel.create({
      organizationId,
      userId,
      clientId,
      platform: "macos",
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await ConnectionSetupModel.claimByToken({ rawToken });
  }

  async function gatewayCall(
    userId: string,
    options: {
      authMethod: "oauth" | "user_token";
      daysAgo: number;
      agentId?: string;
    },
  ) {
    await db.insert(schema.mcpToolCallsTable).values({
      agentId: options.agentId ?? gateway.id,
      mcpServerName: "mcp-gateway",
      method: "tools/list",
      userId,
      authMethod: options.authMethod,
      createdAt: new Date(Date.now() - options.daysAgo * DAY_MS),
    });
  }
});
