import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import chatopsRoutes from "./chatops";

const { reinitializeMock } = vi.hoisted(() => ({
  reinitializeMock: vi.fn(),
}));

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: {
    reinitialize: reinitializeMock,
    getMSTeamsProvider: vi.fn(() => null),
    processMessage: vi.fn(),
    getAccessibleChatopsAgents: vi.fn(),
  },
}));

describe("PUT /api/chatops/config/ms-teams", () => {
  const originalIsQuickstart = config.isQuickstart;
  const originalProduction = config.production;
  const originalMsTeamsConfig = {
    enabled: config.chatops.msTeams.enabled,
    appId: config.chatops.msTeams.appId,
    appSecret: config.chatops.msTeams.appSecret,
    tenantId: config.chatops.msTeams.tenantId,
    graphClientId: config.chatops.msTeams.graph.clientId,
    graphClientSecret: config.chatops.msTeams.graph.clientSecret,
    graphTenantId: config.chatops.msTeams.graph.tenantId,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    config.isQuickstart = originalIsQuickstart;
    config.production = originalProduction;
    config.chatops.msTeams.enabled = originalMsTeamsConfig.enabled;
    config.chatops.msTeams.appId = originalMsTeamsConfig.appId;
    config.chatops.msTeams.appSecret = originalMsTeamsConfig.appSecret;
    config.chatops.msTeams.tenantId = originalMsTeamsConfig.tenantId;
    config.chatops.msTeams.graph.clientId = originalMsTeamsConfig.graphClientId;
    config.chatops.msTeams.graph.clientSecret =
      originalMsTeamsConfig.graphClientSecret;
    config.chatops.msTeams.graph.tenantId = originalMsTeamsConfig.graphTenantId;
  });

  test("returns 403 outside quickstart and local development", async () => {
    config.isQuickstart = false;
    config.production = true;

    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "PUT",
      url: "/api/chatops/config/ms-teams",
      payload: {
        enabled: true,
        appId: "app-id",
        appSecret: "app-secret",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        message:
          "Only available in quickstart or local development mode. Forbidden in production.",
        type: "api_authorization_error",
      },
    });
    expect(reinitializeMock).not.toHaveBeenCalled();

    await app.close();
  });

  test("updates config in local development mode", async () => {
    config.isQuickstart = false;
    config.production = false;

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
    expect(config.chatops.msTeams.enabled).toBe(true);
    expect(config.chatops.msTeams.appId).toBe("dev-app-id");
    expect(config.chatops.msTeams.appSecret).toBe("dev-app-secret");
    expect(config.chatops.msTeams.tenantId).toBe("dev-tenant-id");
    expect(config.chatops.msTeams.graph.clientId).toBe("dev-app-id");
    expect(config.chatops.msTeams.graph.clientSecret).toBe("dev-app-secret");
    expect(config.chatops.msTeams.graph.tenantId).toBe("dev-tenant-id");
    expect(reinitializeMock).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
