import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import { slackAppFactory } from "@/agents/chatops/slack-app-factory";
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
vi.mock("@slack/web-api", async (importOriginal) => ({
  ErrorCode: (await importOriginal<typeof import("@slack/web-api")>())
    .ErrorCode,
  WebClient: class {
    auth = { test: authTestMock };
    tooling = {
      tokens: {
        rotate: () =>
          Promise.resolve({
            ok: true,
            token: "xoxe.xoxp-rotated",
            refresh_token: "xoxe-next",
            exp: Math.floor(Date.now() / 1000) + 12 * 3600,
          }),
      },
    };
    apps = {
      connections: { open: () => Promise.resolve({ ok: true }) },
      manifest: {
        create: () =>
          Promise.resolve({
            ok: true,
            app_id: "A_ROUTER",
            credentials: {
              client_id: "client-1",
              client_secret: "client-secret",
              signing_secret: "signing-secret",
            },
          }),
      },
    };
  },
}));

describe("Slack agent bots", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin }) => {
    vi.clearAllMocks();
    vi.mocked(chatOpsManager.getSlackProvider).mockReturnValue(null);
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
          identitySyncError: null,
          createdByArchestra: false,
          createdBy: null,
        },
      ],
      canCreateApps: false,
      oneClickInstall: false,
      unassignedApp: null,
      workspaceName: null,
    });
    expect(list.body).not.toContain("xoxb-marketing");
  });

  test("names who created a bot, and only the viewer's own token lets them create apps", async ({
    makeInternalAgent,
    makeAdmin,
  }) => {
    const agent = await makeInternalAgent({ organizationId });
    const creator = await makeAdmin({ name: "Dana Creator" });
    await ChatOpsConfigModel.saveSlackAgentBot({
      agentId: agent.id,
      enabled: false,
      botToken: "",
      signingSecret: "s",
      appId: "A_CREATED",
      managed: true,
      configTokenUserId: creator.id,
    });
    await ChatOpsConfigModel.saveSlackAppConfigToken(
      {
        accessToken: "xoxe.xoxp-creator",
        refreshToken: "xoxe-creator",
        expiresAt: Date.now() + 3_600_000,
      },
      creator.id,
    );

    const list = await app.inject({
      method: "GET",
      url: "/api/chatops/config/slack/agents",
    });

    expect(list.json().bots[0].createdBy).toEqual({
      id: creator.id,
      name: "Dana Creator",
    });
    // The creator's token is theirs: this viewer still adds their own.
    expect(list.json().canCreateApps).toBe(false);
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

  describe("creating the router bot", () => {
    const createRouter = () =>
      app.inject({
        method: "POST",
        url: "/api/chatops/config/slack/router/app",
        payload: { appName: "archestra", connectionMode: "socket" },
      });

    test("creates its Slack app with the person's token and records it without secrets", async () => {
      await slackAppFactory.saveConfigToken({
        userId: user.id,
        accessToken: "xoxe.xoxp-pasted",
        refreshToken: "xoxe-1",
      });

      const response = await createRouter();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        appId: "A_ROUTER",
        installMode: "manual",
        installUrl: "https://api.slack.com/apps/A_ROUTER/oauth",
      });
      expect(await ChatOpsConfigModel.getSlackConfig()).toEqual(
        expect.objectContaining({ appId: "A_ROUTER", enabled: false }),
      );

      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.resourceId, organizationId));
      const row = rows.find(
        (candidate) =>
          (candidate.after as { slack?: { hasAppId?: boolean } } | null)?.slack
            ?.hasAppId,
      );
      expect(row).toBeDefined();
      expect(JSON.stringify(row)).not.toContain("client-secret");
      expect(JSON.stringify(row)).not.toContain("signing-secret");
    });

    test("is refused while a router bot is connected", async () => {
      await ChatOpsConfigModel.saveSlackConfig({
        enabled: true,
        botToken: "xoxb-main",
        signingSecret: "",
        appId: "A_MAIN",
        connectionMode: "socket",
        appLevelToken: "xapp-main",
      });
      await slackAppFactory.saveConfigToken({
        userId: user.id,
        accessToken: "xoxe.xoxp-pasted",
        refreshToken: "xoxe-1",
      });

      const response = await createRouter();

      expect(response.statusCode).toBe(400);
      expect((await ChatOpsConfigModel.getSlackConfig())?.appId).toBe("A_MAIN");
    });
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
        handle: null,
        connected: false,
        installed: true,
        needsAppLevelToken: false,
        createdBy: null,
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

  describe("the channels of an agent's bot", () => {
    // The bot's Slack connection is the boundary: a fake stands in for it.
    function fakeBot(
      options: { missingScopes?: string[]; joinError?: string } = {},
    ) {
      const joinChannel = vi.fn(async (channelId: string) => {
        if (options.joinError) {
          throw Object.assign(new Error(options.joinError), {
            data: { error: options.joinError },
          });
        }
        return { channelName: `name-${channelId}` };
      });
      const bot = {
        isConfigured: () => true,
        getWorkspaceId: () => "T1",
        getWorkspaceName: () => "Acme",
        getMissingScopes: () => options.missingScopes ?? [],
        listJoinableChannels: async () => [
          {
            channelId: "C2",
            channelName: "support",
            description: null,
            isPrivate: false,
            isMember: false,
          },
          {
            channelId: "C1",
            channelName: "alerts",
            description: "Production alerts",
            isPrivate: false,
            isMember: true,
          },
          {
            channelId: "C3",
            channelName: "secret",
            description: null,
            isPrivate: true,
            isMember: false,
          },
          {
            channelId: "C4",
            channelName: "leads",
            description: null,
            isPrivate: true,
            isMember: true,
          },
        ],
        joinChannel,
      };
      vi.mocked(chatOpsManager.getSlackProvider).mockReturnValue(
        bot as unknown as ReturnType<typeof chatOpsManager.getSlackProvider>,
      );
      return { joinChannel };
    }

    test("lists the channels the bot is in and the public ones it can join", async ({
      makeInternalAgent,
    }) => {
      const agent = await makeInternalAgent({ organizationId });
      fakeBot({ missingScopes: ["channels:join"] });

      const response = await app.inject({
        method: "GET",
        url: `/api/chatops/config/slack/agents/${agent.id}/channels`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        workspaceId: "T1",
        canJoin: false,
        channels: [
          {
            channelId: "C1",
            channelName: "alerts",
            description: "Production alerts",
            isPrivate: false,
            isMember: true,
          },
          {
            channelId: "C4",
            channelName: "leads",
            description: null,
            isPrivate: true,
            isMember: true,
          },
          {
            channelId: "C2",
            channelName: "support",
            description: null,
            isPrivate: false,
            isMember: false,
          },
        ],
      });
    });

    test("an agent without a bot has no channels to list", async ({
      makeInternalAgent,
    }) => {
      const agent = await makeInternalAgent({ organizationId });

      const response = await app.inject({
        method: "GET",
        url: `/api/chatops/config/slack/agents/${agent.id}/channels`,
      });

      expect(response.statusCode).toBe(404);
    });

    test("joining claims a channel nobody owns, and leaves another agent's alone", async ({
      makeInternalAgent,
    }) => {
      const marketing = await makeInternalAgent({ organizationId });
      const coding = await makeInternalAgent({ organizationId });
      await ChatOpsChannelBindingModel.create({
        organizationId,
        provider: "slack",
        channelId: "C9",
        workspaceId: "T1",
        agentId: coding.id,
      });
      const { joinChannel } = fakeBot();

      const join = (channelId: string) =>
        app.inject({
          method: "POST",
          url: `/api/chatops/config/slack/agents/${marketing.id}/channels/${channelId}/join`,
        });
      expect((await join("C2")).statusCode).toBe(200);
      expect((await join("C9")).statusCode).toBe(200);

      expect(joinChannel.mock.calls.map(([id]) => id)).toEqual(["C2", "C9"]);
      const owner = async (channelId: string) =>
        await ChatOpsChannelBindingModel.findByChannel({
          provider: "slack",
          channelId,
          workspaceId: "T1",
        });
      expect(await owner("C2")).toMatchObject({
        agentId: marketing.id,
        channelName: "name-C2",
      });
      expect((await owner("C9"))?.agentId).toBe(coding.id);

      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.resourceType, "chatOpsBinding"));
      expect(rows.length).toBeGreaterThan(0);
    });

    test("the router bot lists its channels and joins one without picking an agent for it", async ({
      makeInternalAgent,
    }) => {
      const coding = await makeInternalAgent({ organizationId });
      await ChatOpsChannelBindingModel.create({
        organizationId,
        provider: "slack",
        channelId: "C9",
        workspaceId: "T1",
        agentId: coding.id,
      });
      const { joinChannel } = fakeBot();

      const list = await app.inject({
        method: "GET",
        url: "/api/chatops/config/slack/router/channels",
      });
      expect(list.statusCode).toBe(200);
      expect(
        list.json().channels.map((c: { channelId: string }) => c.channelId),
      ).toEqual(["C1", "C4", "C2"]);

      const join = (channelId: string) =>
        app.inject({
          method: "POST",
          url: `/api/chatops/config/slack/router/channels/${channelId}/join`,
        });
      expect((await join("C2")).statusCode).toBe(200);
      expect((await join("C9")).statusCode).toBe(200);

      expect(joinChannel.mock.calls.map(([id]) => id)).toEqual(["C2", "C9"]);
      const binding = async (channelId: string) =>
        await ChatOpsChannelBindingModel.findByChannel({
          provider: "slack",
          channelId,
          workspaceId: "T1",
        });
      expect(await binding("C2")).toMatchObject({
        agentId: null,
        channelName: "name-C2",
      });
      expect((await binding("C9"))?.agentId).toBe(coding.id);

      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.resourceType, "chatOpsBinding"));
      expect(rows.length).toBeGreaterThan(0);
    });

    test("says to reinstall when the bot may not join channels yet", async ({
      makeInternalAgent,
    }) => {
      const agent = await makeInternalAgent({ organizationId });
      fakeBot({ joinError: "missing_scope" });

      const response = await app.inject({
        method: "POST",
        url: `/api/chatops/config/slack/agents/${agent.id}/channels/C2/join`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toMatch(/Reinstall/);
      expect(
        await ChatOpsChannelBindingModel.findByChannel({
          provider: "slack",
          channelId: "C2",
          workspaceId: "T1",
        }),
      ).toBeNull();
    });
  });
});
