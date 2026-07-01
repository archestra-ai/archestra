import { WEBSITE_URL } from "@archestra/shared";

/**
 * Builds the Microsoft Teams app manifest for the Archestra bot.
 *
 * This is the single source of truth for the manifest downloaded from the
 * MS Teams setup wizard.
 */
export function buildTeamsManifest(params: {
  botAppId: string;
  nameShort: string;
  nameFull: string;
  version: string;
}) {
  const { botAppId, nameShort, nameFull, version } = params;
  return {
    $schema:
      "https://developer.microsoft.com/json-schemas/teams/v1.21/MicrosoftTeams.schema.json",
    manifestVersion: "1.21",
    version: version || "1.0.0",
    id: botAppId || "{{BOT_MS_APP_ID}}",
    developer: {
      name: nameShort,
      websiteUrl: WEBSITE_URL,
      privacyUrl: `${WEBSITE_URL}/privacy`,
      termsOfUseUrl: `${WEBSITE_URL}/terms`,
    },
    name: { short: nameShort, full: nameFull },
    description: {
      short: `Ask ${nameShort}`,
      full: `Chat with ${nameShort} agents`,
    },
    icons: { outline: "outline.png", color: "color.png" },
    accentColor: "#FFFFFF",
    bots: [
      {
        botId: botAppId || "{{BOT_MS_APP_ID}}",
        scopes: ["team", "groupChat", "personal", "copilot"],
        // Enables the bot to receive file/image attachments in 1:1 personal
        // chats. Channel and group-chat attachments already arrive regardless
        // of this flag; it specifically unlocks the personal-chat file flow.
        supportsFiles: true,
        isNotificationOnly: false,
        commandLists: [
          {
            scopes: ["team", "groupChat", "personal"],
            commands: [
              {
                title: "/select-agent",
                description: "Change which agent handles this conversation",
              },
              {
                title: "/status",
                description: "Show current agent for this conversation",
              },
              { title: "/help", description: "Show available commands" },
            ],
          },
        ],
      },
    ],
    copilotAgents: {
      customEngineAgents: [
        { type: "bot", id: botAppId || "{{BOT_MS_APP_ID}}" },
      ],
    },
    permissions: ["identity", "messageTeamMembers"],
    validDomains: [],
    webApplicationInfo: {
      id: botAppId || "{{BOT_MS_APP_ID}}",
      resource: "https://graph.microsoft.com",
    },
    authorization: {
      permissions: {
        resourceSpecific: [
          { name: "ChannelMessage.Read.Group", type: "Application" },
          { name: "ChatMessage.Read.Chat", type: "Application" },
          { name: "TeamMember.Read.Group", type: "Application" },
          { name: "ChatMember.Read.Chat", type: "Application" },
        ],
      },
    },
  };
}
