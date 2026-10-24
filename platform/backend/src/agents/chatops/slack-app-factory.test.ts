import { SLACK_REQUIRED_BOT_SCOPES, TimeInMs } from "@archestra/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import config from "@/config";
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
const USER_ID = "user-1";
const originalWebhookBaseUrl = config.chatops.webhookBaseUrl;

afterEach(() => {
  config.chatops.webhookBaseUrl = originalWebhookBaseUrl;
});

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

async function saveToken(userId = USER_ID, refreshToken = "xoxe-1") {
  await slackAppFactory.saveConfigToken({
    userId,
    accessToken: "xoxe.xoxp-pasted",
    refreshToken,
  });
}

describe("SlackAppFactory", () => {
  test.each([
    "agent",
    "router",
  ] as const)("%s app sends events to the webhook origin while OAuth stays on the frontend", async (kind) => {
    config.frontendBaseUrl = "https://app.example.com";
    config.chatops.webhookBaseUrl = "https://hooks.example.com";
    await saveToken();
    const params = {
      appName: "example_bot",
      connectionMode: "webhook" as const,
      organizationId: "org-1",
      userId: USER_ID,
    };
    const result =
      kind === "agent"
        ? await slackAppFactory.createAgentApp({ ...params, agentId: AGENT_ID })
        : await slackAppFactory.createRouterApp(params);
    const { manifest } = slack.create.mock.calls[0][0];
    const webhook = `https://hooks.example.com/api/webhooks/chatops/slack${kind === "agent" ? `/agents/${AGENT_ID}` : ""}`;
    expect(manifest.settings.event_subscriptions.request_url).toBe(webhook);
    expect(manifest.settings.interactivity.request_url).toBe(
      `${webhook}/interactive`,
    );
    if (kind === "router") {
      expect(manifest.features.slash_commands[0].url).toBe(
        `${webhook}/slash-command`,
      );
    }
    const callback =
      "https://app.example.com/api/webhooks/chatops/slack/oauth/callback";
    expect(manifest.oauth_config.redirect_urls).toEqual([callback]);
    expect(new URL(result.installUrl).searchParams.get("redirect_uri")).toBe(
      callback,
    );
  });

  test("retargeting an existing app uses the separate webhook origin", async () => {
    config.chatops.webhookBaseUrl = "https://hooks.example.com";
    await saveToken();
    slack.exportManifest.mockResolvedValue({
      ok: true,
      manifest: { features: {}, settings: {} },
    });
    slack.update.mockResolvedValue({ ok: true });
    await slackAppFactory.retargetAppToAgent({
      appId: "A_EXISTING",
      agentId: AGENT_ID,
      connectionMode: "webhook",
      userId: USER_ID,
    });
    const { manifest } = slack.update.mock.calls[0][0];
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      `https://hooks.example.com/api/webhooks/chatops/slack/agents/${AGENT_ID}`,
    );
    expect(manifest.settings.interactivity.request_url).toBe(
      `https://hooks.example.com/api/webhooks/chatops/slack/agents/${AGENT_ID}/interactive`,
    );
  });

  test("saving a token renews it at once, keeping the new refresh token", async () => {
    await saveToken();

    const saved = await ChatOpsConfigModel.getSlackAppConfigToken(USER_ID);
    expect(saved).toMatchObject({
      accessToken: "xoxe.xoxp-from-xoxe-1",
      refreshToken: "xoxe-1-next",
    });
    expect(await slackAppFactory.hasConfigToken(USER_ID)).toBe(true);
  });

  test("each person's token is their own", async () => {
    await saveToken();

    expect(await slackAppFactory.hasConfigToken("user-2")).toBe(false);
    expect(await ChatOpsConfigModel.getSlackAppConfigToken()).toBeNull();
  });

  test("a token close to expiry is renewed before creating an app", async () => {
    await ChatOpsConfigModel.saveSlackAppConfigToken(
      {
        accessToken: "xoxe.xoxp-old",
        refreshToken: "xoxe-old",
        expiresAt: Date.now() + TimeInMs.Minute,
      },
      USER_ID,
    );

    await slackAppFactory.createAgentApp({
      agentId: AGENT_ID,
      appName: "archestra_marketing",
      connectionMode: "socket",
      organizationId: "org-1",
      userId: USER_ID,
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
      userId: USER_ID,
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
        // Slack makes this person the app's collaborator.
        configTokenUserId: USER_ID,
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
      userId: USER_ID,
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

  test("creates the router bot's app with slash commands and installs it in one click", async () => {
    vi.spyOn(ngrokTunnelManager, "getPublicDomain").mockReturnValue(
      "team.ngrok.app",
    );
    await saveToken();

    const result = await slackAppFactory.createRouterApp({
      appName: "archestra",
      connectionMode: "webhook",
      organizationId: "org-1",
      userId: USER_ID,
    });

    const { manifest } = slack.create.mock.calls[0][0];
    // People pick their agent with /select-agent, so the router keeps it.
    expect(manifest.features.slash_commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringMatching(/select-agent$/),
          url: "https://team.ngrok.app/api/webhooks/chatops/slack/slash-command",
        }),
      ]),
    );
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      "https://team.ngrok.app/api/webhooks/chatops/slack",
    );
    expect(await ChatOpsConfigModel.getSlackConfig()).toEqual(
      expect.objectContaining({
        enabled: false,
        botToken: "",
        appId: "A_NEW",
        clientId: "client-1",
        configTokenUserId: USER_ID,
      }),
    );
    // Agent bots are untouched.
    expect(await ChatOpsConfigModel.getSlackAgentBots()).toEqual([]);

    const state = new URL(result.installUrl).searchParams.get("state") ?? "";
    await expect(
      slackAppFactory.completeOAuthInstall({ code: "code-1", state }),
    ).resolves.toEqual({ agentId: null });
    expect(await ChatOpsConfigModel.getSlackConfig()).toEqual(
      expect.objectContaining({ botToken: "xoxb-installed", enabled: true }),
    );
  });

  test("an install link this server never issued is refused", async () => {
    await expect(
      slackAppFactory.completeOAuthInstall({ code: "c", state: "forged" }),
    ).rejects.toThrow("expired");
    expect(slack.access).not.toHaveBeenCalled();
  });

  test("creating an app needs the person's own configuration token", async () => {
    // A token saved for the whole organization does not create apps.
    await ChatOpsConfigModel.saveSlackAppConfigToken({
      accessToken: "xoxe.xoxp-org",
      refreshToken: "xoxe-org",
      expiresAt: Date.now() + TimeInMs.Hour,
    });

    await expect(
      slackAppFactory.createAgentApp({
        agentId: AGENT_ID,
        appName: "archestra_marketing",
        connectionMode: "socket",
        organizationId: "org-1",
        userId: USER_ID,
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
      configTokenUserId: USER_ID,
    });
    expect(slack.remove).toHaveBeenCalledWith(
      expect.objectContaining({ app_id: "A_NEW" }),
    );
  });

  test("an app created before tokens were per person uses the organization's token", async () => {
    await ChatOpsConfigModel.saveSlackAppConfigToken({
      accessToken: "xoxe.xoxp-org",
      refreshToken: "xoxe-org",
      expiresAt: Date.now() + TimeInMs.Hour,
    });

    await slackAppFactory.deleteCreatedApp({
      agentId: AGENT_ID,
      enabled: true,
      botToken: "xoxb",
      signingSecret: "s",
      appId: "A_OLD",
      managed: true,
    });

    expect(slack.remove).toHaveBeenCalledWith({
      token: "xoxe.xoxp-org",
      app_id: "A_OLD",
    });
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

    const results = await slackAppFactory.migrateExistingApps(USER_ID);

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
    // The hand-made bot is now managed, with this person's token: removing
    // it deletes it from Slack.
    expect(await ChatOpsConfigModel.getSlackAgentBots()).toEqual([
      expect.objectContaining({
        appId: "A_HANDMADE",
        managed: true,
        configTokenUserId: USER_ID,
      }),
    ]);
  });

  test("adds a newly required scope to a managed app's manifest once, with its creator's token", async () => {
    await saveToken();
    await saveToken("user-2", "xoxe-2");
    const bot = {
      agentId: AGENT_ID,
      enabled: true,
      botToken: "xoxb-bot",
      signingSecret: "s",
      appId: "A_SCOPES",
      managed: true,
      configTokenUserId: "user-2",
    };
    slack.exportManifest.mockResolvedValue({
      ok: true,
      manifest: {
        display_information: { name: "Bot" },
        oauth_config: { scopes: { bot: ["chat:write"] } },
      },
    });
    slack.update.mockResolvedValue({ ok: true, permissions_updated: true });

    await slackAppFactory.ensureManifestScopes(bot);
    await slackAppFactory.ensureManifestScopes(bot);

    expect(slack.update).toHaveBeenCalledTimes(1);
    expect(slack.update.mock.calls[0][0].token).toBe("xoxe.xoxp-from-xoxe-2");
    expect(
      slack.update.mock.calls[0][0].manifest.oauth_config.scopes.bot,
    ).toContain("files:write");
  });

  test("repairs missing reaction subscriptions even when all scopes are already present", async () => {
    await saveToken();
    const bot = {
      agentId: AGENT_ID,
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: "s",
      appId: "A_EVENTS",
      managed: true,
      configTokenUserId: USER_ID,
    };
    slack.exportManifest.mockResolvedValue({
      ok: true,
      manifest: {
        display_information: { name: "Test bot" },
        oauth_config: {
          scopes: { bot: [...SLACK_REQUIRED_BOT_SCOPES, "bookmarks:read"] },
        },
        settings: {
          socket_mode_enabled: true,
          event_subscriptions: {
            bot_events: ["app_mention", "message.channels", "channel_created"],
          },
        },
      },
    });
    slack.update.mockResolvedValue({ ok: true });
    await slackAppFactory.ensureManifestScopes(bot);
    await slackAppFactory.ensureManifestScopes(bot);
    expect(slack.update).toHaveBeenCalledTimes(1);
    const manifest = slack.update.mock.calls[0][0].manifest;
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(["reaction_added", "channel_created"]),
    );
    expect(manifest.oauth_config.scopes.bot).toContain("bookmarks:read");
  });

  test("leaves the manifest of an app it does not manage alone", async () => {
    await saveToken();

    await slackAppFactory.ensureManifestScopes({
      agentId: AGENT_ID,
      enabled: true,
      botToken: "xoxb-bot",
      signingSecret: "s",
      appId: "A_HANDS_OFF",
    });

    expect(slack.exportManifest).not.toHaveBeenCalled();
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

    const results = await slackAppFactory.migrateExistingApps(USER_ID);

    expect(results).toEqual([
      { appId: "A_NOT_MINE", ok: false, error: "no_permission" },
      { appId: "A_HANDMADE", agentId: AGENT_ID, ok: true },
    ]);
  });

  test("updates only the bots this person manages, and those nobody manages yet", async () => {
    await saveToken();
    const bot = (agentId: string, appId: string, owner?: string) =>
      ChatOpsConfigModel.saveSlackAgentBot({
        agentId,
        enabled: true,
        botToken: "xoxb",
        signingSecret: "s",
        appId,
        managed: Boolean(owner),
        ...(owner && { configTokenUserId: owner }),
      });
    await bot(AGENT_ID, "A_MINE", USER_ID);
    await bot("33333333-3333-4333-8333-333333333333", "A_TEAMMATE", "user-2");
    await bot("44444444-4444-4444-8444-444444444444", "A_UNOWNED");
    slack.exportManifest.mockResolvedValue({
      ok: true,
      manifest: { features: {} },
    });
    slack.update.mockResolvedValue({ ok: true });

    const results = await slackAppFactory.migrateExistingApps(USER_ID);

    // A teammate's app is theirs: Slack would refuse this token for it.
    expect(results.map((result) => result.appId)).toEqual([
      "A_MINE",
      "A_UNOWNED",
    ]);
    expect(slack.exportManifest).not.toHaveBeenCalledWith(
      expect.objectContaining({ app_id: "A_TEAMMATE" }),
    );
    // The unowned bot is now managed with this person's token.
    expect(
      (await ChatOpsConfigModel.getSlackAgentBots()).find(
        (candidate) => candidate.appId === "A_UNOWNED",
      ),
    ).toMatchObject({ managed: true, configTokenUserId: USER_ID });
  });
});
