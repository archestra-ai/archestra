import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import {
  ChatOpsBotModel,
  ChatOpsConfigModel,
  OrganizationModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import chatopsRoutes from "./chatops";

const { reinitializeMock, startSlackAppMock } = vi.hoisted(() => ({
  reinitializeMock: vi.fn(),
  startSlackAppMock: vi.fn(),
}));

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: {
    reinitialize: reinitializeMock,
    startSlackApp: startSlackAppMock,
    stopSlackApp: vi.fn(),
    getMSTeamsProvider: vi.fn(() => null),
    getSlackProvider: vi.fn(() => null),
    getTelegramProvider: vi.fn(() => null),
    processMessage: vi.fn(),
    getAccessibleChatopsAgents: vi.fn(),
  },
}));

// Mock credential validation so tests don't hit real APIs
vi.mock("botframework-connector", () => ({
  MicrosoftAppCredentials: class {
    getToken() {
      return Promise.resolve("mock-token");
    }
  },
}));

vi.mock("@slack/web-api", () => ({
  WebClient: class {
    constructor(private readonly token?: string) {}
    // Each bot token resolves to its own bot user, like real Slack apps.
    auth = {
      test: () =>
        Promise.resolve({
          ok: true,
          user_id: `U-${this.token}`,
          team_id: "T-test",
        }),
    };
    apps = {
      connections: { open: () => Promise.resolve({ ok: true }) },
    };
  },
}));

describe("PUT /api/chatops/config/ms-teams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("saves config to DB and reinitializes", async () => {
    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "PUT",
      url: "/api/chatops/config/ms-teams",
      payload: {
        enabled: true,
        appId: "dev-app-id",
        appSecret: "dev-app-secret",
        tenantId: "dev-tenant-id",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    // Verify config was saved to DB
    const dbConfig = await ChatOpsConfigModel.getMsTeamsConfig();
    expect(dbConfig).toEqual({
      enabled: true,
      appId: "dev-app-id",
      appSecret: "dev-app-secret",
      tenantId: "dev-tenant-id",
      graphTenantId: "dev-tenant-id",
      graphClientId: "dev-app-id",
      graphClientSecret: "dev-app-secret",
    });

    expect(reinitializeMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  test("merges partial updates with existing DB config", async () => {
    // Seed initial config
    await ChatOpsConfigModel.saveMsTeamsConfig({
      enabled: true,
      appId: "initial-app-id",
      appSecret: "initial-secret",
      tenantId: "initial-tenant",
      graphTenantId: "initial-tenant",
      graphClientId: "initial-app-id",
      graphClientSecret: "initial-secret",
    });

    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    // Only update appId — other fields should be preserved
    const response = await app.inject({
      method: "PUT",
      url: "/api/chatops/config/ms-teams",
      payload: {
        appId: "updated-app-id",
      },
    });

    expect(response.statusCode).toBe(200);

    const dbConfig = await ChatOpsConfigModel.getMsTeamsConfig();
    expect(dbConfig?.appId).toBe("updated-app-id");
    expect(dbConfig?.appSecret).toBe("initial-secret");
    expect(dbConfig?.enabled).toBe(true);

    await app.close();
  });
});

describe("PUT /api/chatops/config/slack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createApp = async (organizationId: string) => {
    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    await app.register(chatopsRoutes);
    return app;
  };

  const putSlack = (
    app: Awaited<ReturnType<typeof createApp>>,
    payload: Record<string, unknown>,
  ) =>
    app.inject({
      method: "PUT",
      url: "/api/chatops/config/slack",
      payload,
    });

  test("creates the organization's first Slack App, saves its config, and reinitializes", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const app = await createApp(organization.id);

    const response = await putSlack(app, {
      enabled: true,
      botToken: "xoxb-test-token",
      signingSecret: "test-secret",
      appId: "A12345",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    const bots = await ChatOpsBotModel.findByProvider({
      organizationId: organization.id,
      provider: "slack",
    });
    expect(bots).toHaveLength(1);
    expect(await ChatOpsConfigModel.getSlackConfig(bots[0])).toEqual({
      enabled: true,
      botToken: "xoxb-test-token",
      signingSecret: "test-secret",
      appId: "A12345",
      connectionMode: "socket",
      appLevelToken: "",
    });

    expect(startSlackAppMock).toHaveBeenCalledWith(bots[0].id);

    await app.close();
  });

  test("updates only the named Slack App's secret", async ({
    makeOrganization,
    makeChatOpsBot,
  }) => {
    const organization = await makeOrganization();
    const firstBot = await ChatOpsConfigModel.saveSlackConfig({
      bot: await makeChatOpsBot(organization.id),
      value: {
        enabled: true,
        botToken: "xoxb-first",
        signingSecret: "first-secret",
        appId: "A1",
        connectionMode: "webhook",
        appLevelToken: "",
      },
    });
    const secondBot = await ChatOpsConfigModel.saveSlackConfig({
      bot: await makeChatOpsBot(organization.id),
      value: {
        enabled: true,
        botToken: "xoxb-second",
        signingSecret: "second-secret",
        appId: "A2",
        connectionMode: "webhook",
        appLevelToken: "",
      },
    });
    const app = await createApp(organization.id);

    const response = await putSlack(app, {
      botId: secondBot.id,
      botToken: "xoxb-second-rotated",
    });

    expect(response.statusCode).toBe(200);
    // Only the updated app restarts; the other app's connection is left alone.
    expect(startSlackAppMock).toHaveBeenCalledTimes(1);
    expect(startSlackAppMock).toHaveBeenCalledWith(secondBot.id);
    // The partial update merges into the second app's own config...
    expect(await ChatOpsConfigModel.getSlackConfig(secondBot)).toMatchObject({
      botToken: "xoxb-second-rotated",
      signingSecret: "second-secret",
      appId: "A2",
    });
    // ...and leaves the first app, and the bot rows, alone.
    expect(await ChatOpsConfigModel.getSlackConfig(firstBot)).toMatchObject({
      botToken: "xoxb-first",
      signingSecret: "first-secret",
      appId: "A1",
    });
    const bots = await ChatOpsBotModel.findByProvider({
      organizationId: organization.id,
      provider: "slack",
    });
    expect(bots.map((bot) => bot.id)).toEqual([firstBot.id, secondBot.id]);
    expect(bots.map((bot) => bot.secretId)).toEqual([
      firstBot.secretId,
      secondBot.secretId,
    ]);

    await app.close();
  });

  test("without a botId updates the first Slack App and does not create another", async ({
    makeOrganization,
    makeChatOpsBot,
  }) => {
    const organization = await makeOrganization();
    const firstBot = await ChatOpsConfigModel.saveSlackConfig({
      bot: await makeChatOpsBot(organization.id),
      value: {
        enabled: true,
        botToken: "xoxb-first",
        signingSecret: "first-secret",
        appId: "A1",
        connectionMode: "webhook",
        appLevelToken: "",
      },
    });
    const laterBot = await makeChatOpsBot(organization.id);
    const app = await createApp(organization.id);

    const response = await putSlack(app, { appId: "A1-renamed" });

    expect(response.statusCode).toBe(200);
    expect(await ChatOpsConfigModel.getSlackConfig(firstBot)).toMatchObject({
      appId: "A1-renamed",
      botToken: "xoxb-first",
    });
    expect(await ChatOpsConfigModel.getSlackConfig(laterBot)).toBeNull();
    expect(
      await ChatOpsBotModel.findByProvider({
        organizationId: organization.id,
        provider: "slack",
      }),
    ).toHaveLength(2);

    await app.close();
  });

  test("reports an unknown, foreign, or non-Slack bot id as 404 and changes nothing", async ({
    makeOrganization,
    makeChatOpsBot,
  }) => {
    const organization = await makeOrganization();
    const teamsBot = await makeChatOpsBot(organization.id, {
      provider: "ms-teams",
    });
    const foreignBot = await makeChatOpsBot((await makeOrganization()).id);
    const app = await createApp(organization.id);

    for (const botId of [crypto.randomUUID(), teamsBot.id, foreignBot.id]) {
      const response = await putSlack(app, { botId, botToken: "xoxb-token" });
      expect(response.statusCode).toBe(404);
    }
    expect(await ChatOpsConfigModel.getSlackConfig(foreignBot)).toBeNull();
    expect(startSlackAppMock).not.toHaveBeenCalled();

    await app.close();
  });
});

describe("PUT /api/chatops/config/telegram", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    // The whole integration sits behind this master switch
    config.chatops.telegramEnabled = true;
    // Bot token validation calls getMe
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { id: 1 } })),
    );
  });

  test("rejects updates when the Telegram feature flag is off", async () => {
    config.chatops.telegramEnabled = false;
    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "PUT",
      url: "/api/chatops/config/telegram",
      payload: { enabled: true, botToken: "123456:test-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(await ChatOpsConfigModel.getTelegramConfig()).toBeNull();

    await app.close();
  });

  test("validates the token via getMe, saves config, and reinitializes", async () => {
    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "PUT",
      url: "/api/chatops/config/telegram",
      payload: { enabled: true, botToken: "123456:test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456:test-token/getMe",
    );

    const dbConfig = await ChatOpsConfigModel.getTelegramConfig();
    expect(dbConfig).toEqual({
      enabled: true,
      botToken: "123456:test-token",
    });

    expect(reinitializeMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  test("rejects an invalid bot token with 400 and does not save", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error_code: 401 })),
    );
    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "PUT",
      url: "/api/chatops/config/telegram",
      payload: { enabled: true, botToken: "bad-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(await ChatOpsConfigModel.getTelegramConfig()).toBeNull();
    expect(reinitializeMock).not.toHaveBeenCalled();

    await app.close();
  });
});

describe("channels the organization turned off", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createApp = async (organizationId: string) => {
    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    await app.register(chatopsRoutes);
    return app;
  };

  test("refuses to configure Slack once it is turned off", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    await OrganizationModel.patch(organization.id, {
      messagingChannelOverrides: { slack: { hidden: true } },
    });
    const app = await createApp(organization.id);

    const response = await app.inject({
      method: "PUT",
      url: "/api/chatops/config/slack",
      payload: { enabled: true, botToken: "xoxb-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("turned off");
    expect(
      await ChatOpsBotModel.findByProvider({
        organizationId: organization.id,
        provider: "slack",
      }),
    ).toEqual([]);
    expect(startSlackAppMock).not.toHaveBeenCalled();

    await app.close();
  });

  test("still configures a channel left switched on", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    await OrganizationModel.patch(organization.id, {
      messagingChannelOverrides: { slack: { hidden: true } },
    });
    const app = await createApp(organization.id);

    const response = await app.inject({
      method: "PUT",
      url: "/api/chatops/config/ms-teams",
      payload: {
        enabled: true,
        appId: "app-id",
        appSecret: "app-secret",
        tenantId: "tenant-id",
      },
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });
});
