import { describe, expect, it } from "vitest";
import { SLACK_REQUIRED_BOT_SCOPES } from "./slack";
import { buildSlackManifest, migrateSlackManifest } from "./slack-manifest";

describe("buildSlackManifest", () => {
  it("slugifies Slack slash commands when the app name contains spaces", () => {
    const manifest = JSON.parse(
      buildSlackManifest({
        appName: "Archestra Staging",
        connectionMode: "socket",
        webhookUrl: "",
        interactiveUrl: "",
        slashCommandUrl: "",
      }),
    );

    expect(manifest.display_information.name).toBe("Archestra Staging");
    expect(manifest.features.bot_user.display_name).toBe("Archestra Staging");
    expect(manifest.features.slash_commands).toEqual([
      {
        command: "/archestra-staging-select-agent",
        description: "Change which agent handles this channel",
      },
      {
        command: "/archestra-staging-status",
        description: "Show current agent for this channel",
      },
      {
        command: "/archestra-staging-help",
        description: "Show available commands",
      },
    ]);
  });

  it("adds webhook slash command URLs for webhook mode", () => {
    const manifest = JSON.parse(
      buildSlackManifest({
        appName: "Archestra",
        connectionMode: "webhook",
        webhookUrl: "https://example.test/api/webhooks/chatops/slack",
        interactiveUrl:
          "https://example.test/api/webhooks/chatops/slack/interactive",
        slashCommandUrl:
          "https://example.test/api/webhooks/chatops/slack/slash-command",
      }),
    );

    expect(manifest.features.slash_commands).toEqual([
      {
        command: "/archestra-select-agent",
        description: "Change which agent handles this channel",
        url: "https://example.test/api/webhooks/chatops/slack/slash-command",
      },
      {
        command: "/archestra-status",
        description: "Show current agent for this channel",
        url: "https://example.test/api/webhooks/chatops/slack/slash-command",
      },
      {
        command: "/archestra-help",
        description: "Show available commands",
        url: "https://example.test/api/webhooks/chatops/slack/slash-command",
      },
    ]);
  });

  it("uses the shared Slack bot scopes", () => {
    const manifest = JSON.parse(
      buildSlackManifest({
        appName: "Archestra",
        connectionMode: "socket",
        webhookUrl: "",
        interactiveUrl: "",
        slashCommandUrl: "",
      }),
    );

    expect(manifest.oauth_config.scopes.bot).toEqual(SLACK_REQUIRED_BOT_SCOPES);
  });

  // The Stop button only appears when the app subscribes to
  // agent_session_stopped, and suggested prompts need app_home_opened, both on
  // an app using the Agent messaging experience — pin them in both modes.
  it.each([
    "socket",
    "webhook",
  ] as const)("declares an agent with Stop and DM-open events (%s mode)", (connectionMode) => {
    const manifest = JSON.parse(
      buildSlackManifest({
        appName: "Archestra",
        connectionMode,
        webhookUrl: "https://example.test/webhook",
        interactiveUrl: "https://example.test/interactive",
        slashCommandUrl: "https://example.test/slash",
      }),
    );

    expect(manifest.features.agent_view).toBeDefined();
    expect(manifest.features.assistant_view).toBeUndefined();
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(["agent_session_stopped", "app_home_opened"]),
    );
  });
});

describe("migrateSlackManifest", () => {
  const legacy = {
    display_information: { name: "Acme Bot", background_color: "#123456" },
    features: {
      bot_user: { display_name: "acmebot", always_online: true },
      assistant_view: { assistant_description: "Helps the Acme team" },
      slash_commands: [{ command: "/acme-help", description: "Help" }],
    },
    oauth_config: {
      scopes: { bot: ["chat:write", "reactions:read"], user: ["search:read"] },
      redirect_urls: ["https://acme.example/callback"],
    },
    settings: {
      event_subscriptions: {
        request_url: "https://acme.example/api/webhooks/chatops/slack",
        bot_events: ["app_mention", "reaction_added"],
      },
      socket_mode_enabled: false,
    },
  };

  it("moves an app to the agent experience with the current events and scopes", () => {
    const migrated = migrateSlackManifest(legacy) as typeof legacy & {
      features: { agent_view: { agent_description: string } };
    };

    expect(migrated.features.assistant_view).toBeUndefined();
    expect(migrated.features.agent_view).toEqual({
      agent_description: "Helps the Acme team",
    });
    expect(migrated.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(["agent_session_stopped", "app_home_opened"]),
    );
    expect(migrated.settings.event_subscriptions.bot_events).not.toContain(
      "reaction_added",
    );
    expect(migrated.oauth_config.scopes.bot).toEqual([
      ...SLACK_REQUIRED_BOT_SCOPES,
    ]);
  });

  it("keeps everything else the admin set", () => {
    const migrated = migrateSlackManifest(legacy) as typeof legacy;

    expect(migrated.display_information).toEqual(legacy.display_information);
    expect(migrated.features.bot_user).toEqual(legacy.features.bot_user);
    expect(migrated.features.slash_commands).toEqual(
      legacy.features.slash_commands,
    );
    expect(migrated.oauth_config.scopes.user).toEqual(["search:read"]);
    expect(migrated.oauth_config.redirect_urls).toEqual(
      legacy.oauth_config.redirect_urls,
    );
    expect(migrated.settings.event_subscriptions.request_url).toBe(
      legacy.settings.event_subscriptions.request_url,
    );
    expect(migrated.settings.socket_mode_enabled).toBe(false);
  });
});
