import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { ChatOpsChannelBindingModel, ChatOpsConfigModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import chatopsRoutes from "./chatops";

const { reinitializeMock } = vi.hoisted(() => ({
  reinitializeMock: vi.fn(),
}));

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: {
    reinitialize: reinitializeMock,
    getMSTeamsProvider: vi.fn(() => null),
    getSlackProvider: vi.fn(() => null),
    getTelegramProvider: vi.fn(() => null),
    processMessage: vi.fn(),
    getAccessibleChatopsAgents: vi.fn(),
  },
}));

// Slack is the process boundary: credential checks succeed unless a test says
// otherwise.
const { authTestMock } = vi.hoisted(() => ({
  authTestMock: vi.fn(() => Promise.resolve({ ok: true })),
}));
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    auth = { test: authTestMock };
    apps = {
      connections: { open: () => Promise.resolve({ ok: true }) },
    };
  },
}));

describe("Slack agent bots", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin }) => {
    vi.clearAllMocks();
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(chatopsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const connect = (agentId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: `/api/chatops/config/slack/agents/${agentId}`,
      payload,
    });

  test("connects a bot for an agent, lists it without secrets, and reconnects Slack", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId,
      name: "Marketing",
    });

    const response = await connect(agent.id, {
      botToken: "xoxb-marketing",
      appLevelToken: "xapp-marketing",
      appId: "A_MARKETING",
      connectionMode: "socket",
    });
    expect(response.statusCode).toBe(200);
    expect(reinitializeMock).toHaveBeenCalledTimes(1);
    expect(await ChatOpsConfigModel.getSlackAgentBots()).toEqual([
      expect.objectContaining({
        agentId: agent.id,
        enabled: true,
        botToken: "xoxb-marketing",
        appId: "A_MARKETING",
      }),
    ]);

    const list = await app.inject({
      method: "GET",
      url: "/api/chatops/config/slack/agents",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      bots: [
        {
          agentId: agent.id,
          agentName: "Marketing",
          enabled: true,
          connectionMode: "socket",
          appId: "A_MARKETING",
          connected: false,
          botUserId: null,
          teamId: null,
          installed: true,
          needsAppLevelToken: false,
          missingScopes: [],
          reinstallUrl: null,
          handle: null,
          createdByArchestra: false,
        },
      ],
      canCreateApps: false,
      oneClickInstall: false,
      unassignedApp: null,
      workspaceName: null,
    });
    expect(list.body).not.toContain("xoxb-marketing");
  });

  test("refuses a Slack app that is already connected", async ({
    makeInternalAgent,
  }) => {
    const marketing = await makeInternalAgent({ organizationId });
    const coding = await makeInternalAgent({ organizationId });
    await connect(marketing.id, { botToken: "xoxb-1", appId: "A_SHARED" });

    const response = await connect(coding.id, {
      botToken: "xoxb-2",
      appId: "A_SHARED",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("already connected");
    expect(
      (await ChatOpsConfigModel.getSlackAgentBots()).map((bot) => bot.agentId),
    ).toEqual([marketing.id]);
  });

  test("rejects credentials Slack does not accept and saves nothing", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({ organizationId });
    authTestMock.mockRejectedValueOnce(new Error("invalid_auth"));

    const response = await connect(agent.id, { botToken: "xoxb-bad" });

    expect(response.statusCode).toBe(400);
    expect(await ChatOpsConfigModel.getSlackAgentBots()).toEqual([]);
    expect(reinitializeMock).not.toHaveBeenCalled();
  });

  test("refuses an agent from another organization", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const other = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: other.id });

    const response = await connect(agent.id, { botToken: "xoxb-1" });

    expect(response.statusCode).toBe(404);
    expect(await ChatOpsConfigModel.getSlackAgentBots()).toEqual([]);
  });

  test("disconnects a bot and leaves the others", async ({
    makeInternalAgent,
  }) => {
    const marketing = await makeInternalAgent({ organizationId });
    const coding = await makeInternalAgent({ organizationId });
    await connect(marketing.id, { botToken: "xoxb-1", appId: "A_1" });
    await connect(coding.id, { botToken: "xoxb-2", appId: "A_2" });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/chatops/config/slack/agents/${marketing.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(
      (await ChatOpsConfigModel.getSlackAgentBots()).map((bot) => bot.agentId),
    ).toEqual([coding.id]);

    const again = await app.inject({
      method: "DELETE",
      url: `/api/chatops/config/slack/agents/${marketing.id}`,
    });
    expect(again.statusCode).toBe(404);
  });

  test("records connecting a bot in the audit log without its secrets", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({ organizationId });

    await connect(agent.id, { botToken: "xoxb-secret", appId: "A_AUDIT" });

    const [row] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, organizationId));
    expect(row).toBeDefined();
    expect(
      (row.before as { slackAgentBots?: unknown[] } | null)?.slackAgentBots,
    ).toEqual([]);
    expect(
      (row.after as { slackAgentBots?: unknown[] } | null)?.slackAgentBots,
    ).toEqual([
      {
        agentId: agent.id,
        enabled: true,
        connectionMode: "socket",
        hasBotToken: true,
      },
    ]);
    expect(JSON.stringify(row)).not.toContain("xoxb-secret");
  });

  describe("converting the channel-routed Slack app", () => {
    async function connectMainApp(connectionMode: "socket" | "webhook") {
      await ChatOpsConfigModel.saveSlackConfig({
        enabled: true,
        botToken: "xoxb-main",
        signingSecret: "signing-main",
        appId: "A_MAIN",
        connectionMode,
        appLevelToken: connectionMode === "socket" ? "xapp-main" : "",
      });
    }

    const convert = (agentId: string) =>
      app.inject({
        method: "POST",
        url: "/api/chatops/config/slack/convert-app",
        payload: { agentId },
      });

    test("lists it with the agent most of its channels use first", async ({
      makeInternalAgent,
    }) => {
      await connectMainApp("socket");
      const support = await makeInternalAgent({
        organizationId,
        name: "Support",
      });
      const sales = await makeInternalAgent({ organizationId, name: "Sales" });
      for (const [channelId, agentId] of [
        ["C1", support.id],
        ["C2", support.id],
        ["C3", sales.id],
      ]) {
        await ChatOpsChannelBindingModel.create({
          organizationId,
          provider: "slack",
          channelId,
          workspaceId: "T1",
          agentId,
        });
      }

      const list = await app.inject({
        method: "GET",
        url: "/api/chatops/config/slack/agents",
      });

      expect(list.json().unassignedApp).toEqual({
        appId: "A_MAIN",
        connectionMode: "socket",
        agentUsage: [
          { agentId: support.id, agentName: "Support", bindings: 2 },
          { agentId: sales.id, agentName: "Sales", bindings: 1 },
        ],
      });
    });

    test("becomes the agent's bot with its credentials, and the old app goes away", async ({
      makeInternalAgent,
    }) => {
      await connectMainApp("socket");
      const agent = await makeInternalAgent({ organizationId });

      const response = await convert(agent.id);

      expect(response.statusCode).toBe(200);
      expect(await ChatOpsConfigModel.getSlackAgentBots()).toEqual([
        expect.objectContaining({
          agentId: agent.id,
          enabled: true,
          botToken: "xoxb-main",
          appLevelToken: "xapp-main",
          appId: "A_MAIN",
          connectionMode: "socket",
        }),
      ]);
      expect(await ChatOpsConfigModel.getSlackConfig()).toMatchObject({
        enabled: false,
        botToken: "",
      });
      expect(reinitializeMock).toHaveBeenCalledTimes(1);

      const list = await app.inject({
        method: "GET",
        url: "/api/chatops/config/slack/agents",
      });
      expect(list.json().unassignedApp).toBeNull();
    });

    test("a webhook app needs the configuration token to move its URLs", async ({
      makeInternalAgent,
    }) => {
      await connectMainApp("webhook");
      const agent = await makeInternalAgent({ organizationId });

      const response = await convert(agent.id);

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("configuration token");
      expect(await ChatOpsConfigModel.getSlackAgentBots()).toEqual([]);
      expect(await ChatOpsConfigModel.getSlackConfig()).toMatchObject({
        enabled: true,
      });
    });

    test("refuses an agent that already has a bot", async ({
      makeInternalAgent,
    }) => {
      await connectMainApp("socket");
      const agent = await makeInternalAgent({ organizationId });
      await connect(agent.id, { botToken: "xoxb-own", appId: "A_OWN" });

      const response = await convert(agent.id);

      expect(response.statusCode).toBe(400);
      expect(await ChatOpsConfigModel.getSlackConfig()).toMatchObject({
        enabled: true,
      });
    });
  });
});
