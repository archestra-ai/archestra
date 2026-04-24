import { SLACK_REQUIRED_BOT_SCOPES } from "@shared";
import { describe, expect, it } from "vitest";
import { buildSlackManifest } from "./slack-manifest";

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
});
