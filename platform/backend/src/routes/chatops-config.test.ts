import { MEMBER_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import { ChatOpsConfigModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { beforeEach, describe, expect, test } from "@/test";
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
    auth = { test: () => Promise.resolve({ ok: true }) };
    apps = {
      connections: { open: () => Promise.resolve({ ok: true }) },
    };
  },
}));

/**
 * These tests register the routes bare, without the auth middleware that
 * guarantees `request.user` on every /api route in production. The channel
 * guard resolves the caller's role, so stub a user in — one with no member
 * record, which resolves to the organization-wide (here: unrestricted) access.
 */
const registerRoutes = async (app: FastifyInstanceWithZod) => {
  app.addHook("onRequest", async (request) => {
    const mutable = request as typeof request & { user?: User };
    mutable.user ??= { id: "chatops-config-test-user" } as User;
  });
  await app.register(chatopsRoutes);
};

describe("PUT /api/chatops/config/ms-teams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("saves config to DB and reinitializes", async () => {
    const app = createFastifyInstance();
    await registerRoutes(app);

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
    await registerRoutes(app);

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

  test("saves config to DB and reinitializes", async () => {
    const app = createFastifyInstance();
    await registerRoutes(app);

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
    await registerRoutes(app);

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
    await registerRoutes(app);

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
    await registerRoutes(app);

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

describe("channels the caller's role excludes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createApp = async (organizationId: string, user: User) => {
    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    await app.register(chatopsRoutes);
    return app;
  };

  test("refuses to configure a channel the role does not allow", async ({
    makeOrganization,
    makeUser,
    makeMember,
    restrictRoleResourceAccess,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id);
    await restrictRoleResourceAccess(
      organization.id,
      { messagingChannels: ["ms-teams"] },
      MEMBER_ROLE_NAME,
    );
    const app = await createApp(organization.id, user);

    const response = await app.inject({
      method: "PUT",
      url: "/api/chatops/config/slack",
      payload: { enabled: true, botToken: "xoxb-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "not available to your role",
    );
    expect(await ChatOpsConfigModel.getSlackConfig()).toBeNull();
    expect(reinitializeMock).not.toHaveBeenCalled();

    await app.close();
  });

  test("still configures a channel the role keeps", async ({
    makeOrganization,
    makeUser,
    makeMember,
    restrictRoleResourceAccess,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id);
    await restrictRoleResourceAccess(
      organization.id,
      { messagingChannels: ["ms-teams"] },
      MEMBER_ROLE_NAME,
    );
    const app = await createApp(organization.id, user);

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
