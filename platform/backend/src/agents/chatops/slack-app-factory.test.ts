import { TimeInMs } from "@archestra/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ChatOpsConfigModel } from "@/models";
import { ngrokTunnelManager } from "@/ngrok-tunnel-manager";
import { setupTestCacheManager } from "@/test/cache-manager";
import { slackAppFactory } from "./slack-app-factory";

// The real cache, stored in this file's test database: it holds install state.
setupTestCacheManager();

// Slack's Web API is the process boundary.
const slack = vi.hoisted(() => ({
  rotate: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  exportManifest: vi.fn(),
  update: vi.fn(),
  access: vi.fn(),
}));
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    tooling = { tokens: { rotate: slack.rotate } };
    apps = {
      manifest: {
        create: slack.create,
        delete: slack.remove,
        export: slack.exportManifest,
        update: slack.update,
      },
    };
    oauth = { v2: { access: slack.access } };
  },
}));

const AGENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  // Plain HTTP unless a test opts into a tunnel.
  vi.spyOn(ngrokTunnelManager, "getPublicDomain").mockReturnValue("");
  slack.rotate.mockImplementation(async ({ refresh_token }) => ({
    ok: true,
    token: `xoxe.xoxp-from-${refresh_token}`,
    refresh_token: `${refresh_token}-next`,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
  }));
  slack.create.mockResolvedValue({
    ok: true,
    app_id: "A_NEW",
    credentials: {
      client_id: "client-1",
      client_secret: "client-secret",
      signing_secret: "signing-secret",
      verification_token: "verify",
    },
    oauth_authorize_url:
      "https://slack.com/oauth/v2/authorize?client_id=client-1&scope=chat:write",
  });
  slack.access.mockResolvedValue({ ok: true, access_token: "xoxb-installed" });
  slack.remove.mockResolvedValue({ ok: true });
});

async function saveToken() {
  await slackAppFactory.saveConfigToken({
    accessToken: "xoxe.xoxp-pasted",
    refreshToken: "xoxe-1",
  });
}

describe("SlackAppFactory", () => {
  test("saving a token renews it at once, keeping the new refresh token", async () => {
    await saveToken();

    const saved = await ChatOpsConfigModel.getSlackAppConfigToken();
    expect(saved).toMatchObject({
      accessToken: "xoxe.xoxp-from-xoxe-1",
      refreshToken: "xoxe-1-next",
    });
    expect(await slackAppFactory.hasConfigToken()).toBe(true);
  });

  test("a token close to expiry is renewed before creating an app", async () => {
    await ChatOpsConfigModel.saveSlackAppConfigToken({
      accessToken: "xoxe.xoxp-old",
      refreshToken: "xoxe-old",
      expiresAt: Date.now() + TimeInMs.Minute,
    });

    await slackAppFactory.createAgentApp({
      agentId: AGENT_ID,
      appName: "archestra_marketing",
      connectionMode: "socket",
      organizationId: "org-1",
    });

    expect(slack.rotate).toHaveBeenCalledWith({ refresh_token: "xoxe-old" });
    expect(slack.create).toHaveBeenCalledWith(
      expect.objectContaining({ token: "xoxe.xoxp-from-xoxe-old" }),
    );
  });

  test("creates the app from a manifest and saves it, not yet installed", async () => {
    await saveToken();

    const result = await slackAppFactory.createAgentApp({
      agentId: AGENT_ID,
      appName: "archestra_marketing",
      connectionMode: "socket",
      organizationId: "org-1",
    });

    const { manifest } = slack.create.mock.calls[0][0];
    expect(manifest.display_information.name).toBe("archestra_marketing");
    expect(manifest.features.slash_commands).toBeUndefined();
    expect(manifest.settings.event_subscriptions.bot_events).toContain(
      "agent_session_stopped",
    );
    expect(await ChatOpsConfigModel.getSlackAgentBots()).toEqual([
      expect.objectContaining({
        agentId: AGENT_ID,
        enabled: false,
        botToken: "",
        appId: "A_NEW",
        signingSecret: "signing-secret",
        clientId: "client-1",
        clientSecret: "client-secret",
      }),
    ]);
    // Without an HTTPS URL Slack cannot redirect back, so the admin installs
    // from the app's own page.
    expect(result).toEqual({
      appId: "A_NEW",
      installMode: "manual",
      installUrl: "https://api.slack.com/apps/A_NEW/oauth",
    });
  });

  test("with an HTTPS URL the install is one click and finishes on its own", async () => {
    vi.spyOn(ngrokTunnelManager, "getPublicDomain").mockReturnValue(
      "team.ngrok.app",
    );
    await saveToken();

    const result = await slackAppFactory.createAgentApp({
      agentId: AGENT_ID,
      appName: "archestra_marketing",
      connectionMode: "webhook",
      organizationId: "org-1",
    });

    const callbackUrl =
      "https://team.ngrok.app/api/webhooks/chatops/slack/oauth/callback";
    expect(slack.create.mock.calls[0][0].manifest.oauth_config).toMatchObject({
      redirect_urls: [callbackUrl],
    });
    expect(
      slack.create.mock.calls[0][0].manifest.settings.event_subscriptions
        .request_url,
    ).toBe(
      `https://team.ngrok.app/api/webhooks/chatops/slack/agents/${AGENT_ID}`,
    );
    expect(result.installMode).toBe("oauth");
    const installUrl = new URL(result.installUrl);
    expect(installUrl.searchParams.get("redirect_uri")).toBe(callbackUrl);
    const state = installUrl.searchParams.get("state") ?? "";
    expect(state).not.toBe("");

    await expect(
      slackAppFactory.completeOAuthInstall({ code: "code-1", state }),
    ).resolves.toEqual({ agentId: AGENT_ID });
    expect(slack.access).toHaveBeenCalledWith({
      client_id: "client-1",
      client_secret: "client-secret",
      code: "code-1",
      redirect_uri: callbackUrl,
    });
    expect(await ChatOpsConfigModel.getSlackAgentBots()).toEqual([
      expect.objectContaining({ botToken: "xoxb-installed", enabled: true }),
    ]);

    // The state is good for one install only.
    await expect(
      slackAppFactory.completeOAuthInstall({ code: "code-2", state }),
    ).rejects.toThrow("expired");
  });

  test("an install link this server never issued is refused", async () => {
    await expect(
      slackAppFactory.completeOAuthInstall({ code: "c", state: "forged" }),
    ).rejects.toThrow("expired");
    expect(slack.access).not.toHaveBeenCalled();
  });

  test("creating an app needs a configuration token", async () => {
    await expect(
      slackAppFactory.createAgentApp({
        agentId: AGENT_ID,
        appName: "archestra_marketing",
        connectionMode: "socket",
        organizationId: "org-1",
      }),
    ).rejects.toThrow("configuration token");
    expect(slack.create).not.toHaveBeenCalled();
  });

  test("deletes from Slack only an app Archestra created", async () => {
    await saveToken();

    await slackAppFactory.deleteCreatedApp({
      agentId: AGENT_ID,
      enabled: true,
      botToken: "xoxb",
      signingSecret: "s",
      appId: "A_HANDMADE",
    });
    expect(slack.remove).not.toHaveBeenCalled();

    await slackAppFactory.deleteCreatedApp({
      agentId: AGENT_ID,
      enabled: true,
      botToken: "xoxb",
      signingSecret: "s",
      appId: "A_NEW",
      clientId: "client-1",
      clientSecret: "client-secret",
    });
    expect(slack.remove).toHaveBeenCalledWith(
      expect.objectContaining({ app_id: "A_NEW" }),
    );
  });

  test("migrates the main app and a hand-made agent bot to the agent experience", async () => {
    await saveToken();
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb-main",
      signingSecret: "s",
      appId: "A_MAIN",
    });
    await ChatOpsConfigModel.saveSlackAgentBot({
      agentId: AGENT_ID,
      enabled: true,
      botToken: "xoxb-bot",
      signingSecret: "s",
      appId: "A_HANDMADE",
    });
    slack.exportManifest.mockImplementation(async ({ app_id }) => ({
      ok: true,
      manifest: {
        display_information: { name: app_id },
        features: { assistant_view: { assistant_description: "old" } },
        oauth_config: { scopes: { bot: ["chat:write", "reactions:read"] } },
        settings: { event_subscriptions: { bot_events: ["reaction_added"] } },
      },
    }));
    slack.update.mockImplementation(async ({ app_id }) => ({
      ok: true,
      permissions_updated: app_id === "A_MAIN",
    }));

    const results = await slackAppFactory.migrateExistingApps();

    expect(results).toEqual([
      {
        appId: "A_MAIN",
        ok: true,
        reinstallUrl: "https://api.slack.com/apps/A_MAIN/oauth",
      },
      { appId: "A_HANDMADE", agentId: AGENT_ID, ok: true },
    ]);
    const updatedManifest = slack.update.mock.calls[0][0].manifest;
    expect(updatedManifest.display_information).toEqual({ name: "A_MAIN" });
    expect(updatedManifest.features.agent_view).toEqual({
      agent_description: "old",
    });
    expect(updatedManifest.settings.event_subscriptions.bot_events).toContain(
      "agent_session_stopped",
    );
    // The hand-made bot is now managed: removing it deletes it from Slack.
    expect(await ChatOpsConfigModel.getSlackAgentBots()).toEqual([
      expect.objectContaining({ appId: "A_HANDMADE", managed: true }),
    ]);
  });

  test("one app Slack refuses does not stop the others", async () => {
    await saveToken();
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb-main",
      signingSecret: "s",
      appId: "A_NOT_MINE",
    });
    await ChatOpsConfigModel.saveSlackAgentBot({
      agentId: AGENT_ID,
      enabled: true,
      botToken: "xoxb-bot",
      signingSecret: "s",
      appId: "A_HANDMADE",
    });
    slack.exportManifest.mockImplementation(async ({ app_id }) => {
      if (app_id === "A_NOT_MINE") throw new Error("no_permission");
      return { ok: true, manifest: { features: {} } };
    });
    slack.update.mockResolvedValue({ ok: true });

    const results = await slackAppFactory.migrateExistingApps();

    expect(results).toEqual([
      { appId: "A_NOT_MINE", ok: false, error: "no_permission" },
      { appId: "A_HANDMADE", agentId: AGENT_ID, ok: true },
    ]);
  });
});
