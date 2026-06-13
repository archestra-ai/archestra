import { describe, expect, it } from "vitest";
import { buildTeamsManifest } from "./teams-manifest";

const baseParams = {
  botAppId: "11111111-2222-3333-4444-555555555555",
  nameShort: "Archestra",
  nameFull: "Archestra Bot",
  version: "1.0.0",
};

describe("buildTeamsManifest", () => {
  it("enables file/image attachments so the bot receives uploads in 1:1 chats", () => {
    const manifest = buildTeamsManifest(baseParams);

    expect(manifest.bots[0].supportsFiles).toBe(true);
  });

  it("injects the bot app ID into every bot reference", () => {
    const manifest = buildTeamsManifest(baseParams);

    expect(manifest.id).toBe(baseParams.botAppId);
    expect(manifest.bots[0].botId).toBe(baseParams.botAppId);
    expect(manifest.webApplicationInfo.id).toBe(baseParams.botAppId);
    expect(manifest.copilotAgents.customEngineAgents[0].id).toBe(
      baseParams.botAppId,
    );
  });

  it("falls back to a placeholder app ID when none is provided", () => {
    const manifest = buildTeamsManifest({ ...baseParams, botAppId: "" });

    expect(manifest.id).toBe("{{BOT_MS_APP_ID}}");
    expect(manifest.bots[0].botId).toBe("{{BOT_MS_APP_ID}}");
  });

  it("declares the resource-specific consent permissions for history and identity", () => {
    const manifest = buildTeamsManifest(baseParams);

    expect(manifest.authorization.permissions.resourceSpecific).toEqual([
      { name: "ChannelMessage.Read.Group", type: "Application" },
      { name: "ChatMessage.Read.Chat", type: "Application" },
      { name: "TeamMember.Read.Group", type: "Application" },
      { name: "ChatMember.Read.Chat", type: "Application" },
    ]);
  });
});
