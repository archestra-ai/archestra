import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { ChatOpsConfigModel, OrganizationModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { drainBackgroundWork } from "@/utils/background-work";
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

vi.mock("@slack/web-api", () => ({
  WebClient: class {
    auth = { test: () => Promise.resolve({ ok: true }) };
    apps = {
      connections: { open: () => Promise.resolve({ ok: true }) },
    };
  },
}));

const tokenHandler = http.post(
  "https://login.microsoftonline.com/:tenant/oauth2/v2.0/token",
  () =>
    HttpResponse.json({
      token_type: "Bearer",
      access_token: "test-token",
      expires_in: 3600,
    }),
);

describe("PUT /api/chatops/config/ms-teams", () => {
  const server = useMswServer(tokenHandler);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("saves config to DB, reinitializes, and audits a redacted change", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      request.organizationId = org.id;
      request.user = user;
    });
    registerAuditLogHook(app);
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
      groupChatFileSignIn: false,
    });

    expect(reinitializeMock).toHaveBeenCalledTimes(1);
    await drainBackgroundWork();
    const { data: audits } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      resourceType: "chatOpsConfig",
      limit: 10,
      offset: 0,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "chatOpsConfig.updated",
      outcome: "success",
    });
    expect(audits[0].after).not.toBeNull();
    expect(audits[0].before).not.toEqual(audits[0].after);
    expect(JSON.stringify(audits[0])).not.toContain("dev-app-secret");
    await app.close();
  });

  test("rejects invalid Azure credentials without changing saved config or reinitializing", async () => {
    const previous = {
      enabled: false,
      appId: "previous-app",
      appSecret: "previous-secret",
      tenantId: "previous-tenant",
      graphTenantId: "previous-tenant",
      graphClientId: "previous-app",
      graphClientSecret: "previous-secret",
    };
    await ChatOpsConfigModel.saveMsTeamsConfig(previous);
    server.use(
      http.post(
        "https://login.microsoftonline.com/:tenant/oauth2/v2.0/token",
        () =>
          HttpResponse.json(
            {
              error: "invalid_client",
              error_description: "Invalid client secret",
            },
            { status: 401 },
          ),
      ),
    );
    const app = createFastifyInstance();
    await app.register(chatopsRoutes);
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/chatops/config/ms-teams",
        payload: {
          enabled: true,
          appId: "new-app",
          appSecret: "invalid-secret",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "Invalid MS Teams credentials",
      );
      expect(await ChatOpsConfigModel.getMsTeamsConfig()).toEqual(previous);
      expect(reinitializeMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
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

describe("Teams group-chat file sign-in setting", () => {
  useMswServer(tokenHandler);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("turning it on keeps the credentials, is audited, and reads back with the redirect URI to register", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await ChatOpsConfigModel.saveMsTeamsConfig({
      enabled: true,
      appId: "teams-app",
      appSecret: "teams-secret",
      tenantId: "teams-tenant",
      graphTenantId: "teams-tenant",
      graphClientId: "teams-app",
      graphClientSecret: "teams-secret",
    });
    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      request.organizationId = org.id;
      request.user = user;
    });
    registerAuditLogHook(app);
    await app.register(chatopsRoutes);
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/chatops/config/ms-teams",
        payload: { groupChatFileSignIn: true },
      });
      expect(response.statusCode).toBe(200);

      expect(await ChatOpsConfigModel.getMsTeamsConfig()).toMatchObject({
        appId: "teams-app",
        appSecret: "teams-secret",
        groupChatFileSignIn: true,
      });
      const view = await app.inject({
        method: "GET",
        url: "/api/chatops/config/ms-teams",
      });
      expect(view.json()).toMatchObject({
        groupChatFileSignIn: true,
        signInRedirectUri: `${config.frontendBaseUrl.replace(/\/+$/, "")}/api/webhooks/chatops/ms-teams/sign-in/callback`,
      });

      await drainBackgroundWork();
      const { data: audits } = await AuditLogModel.findPaginated({
        organizationId: org.id,
        resourceType: "chatOpsConfig",
        limit: 10,
        offset: 0,
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].before).toMatchObject({
        msTeams: { groupChatFileSignIn: false },
      });
      expect(audits[0].after).toMatchObject({
        msTeams: { groupChatFileSignIn: true },
      });
      expect(JSON.stringify(audits[0])).not.toContain("teams-secret");
    } finally {
      await app.close();
    }
  });
});

describe("PUT /api/chatops/config/slack", () => {
  useMswServer(tokenHandler);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("saves config to DB and reinitializes", async () => {
    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "PUT",
      url: "/api/chatops/config/slack",
      payload: {
        enabled: true,
        botToken: "xoxb-test-token",
        signingSecret: "test-secret",
        appId: "A12345",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    const dbConfig = await ChatOpsConfigModel.getSlackConfig();
    expect(dbConfig).toEqual({
      enabled: true,
      botToken: "xoxb-test-token",
      signingSecret: "test-secret",
      appId: "A12345",
      connectionMode: "socket",
      appLevelToken: "",
    });

    expect(reinitializeMock).toHaveBeenCalledTimes(1);

    await app.close();
  });
});

describe("PUT /api/chatops/config/telegram", () => {
  useMswServer(tokenHandler);
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
  useMswServer(tokenHandler);
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
    expect(await ChatOpsConfigModel.getSlackConfig()).toBeNull();
    expect(reinitializeMock).not.toHaveBeenCalled();

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
