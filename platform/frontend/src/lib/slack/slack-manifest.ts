import { buildSlackSlashCommands, SLACK_REQUIRED_BOT_SCOPES } from "@shared";

type SlackManifestConnectionMode = "socket" | "webhook";

export function buildSlackManifest(params: {
  appName: string;
  connectionMode: SlackManifestConnectionMode;
  webhookUrl: string;
  interactiveUrl: string;
  slashCommandUrl: string;
}): string {
  const {
    appName,
    connectionMode,
    webhookUrl,
    interactiveUrl,
    slashCommandUrl,
  } = params;
  const isSocket = connectionMode === "socket";
  const slackSlashCommands = buildSlackSlashCommands(appName);

  const slashCommands = [
    {
      command: slackSlashCommands.SELECT_AGENT,
      description: "Change which agent handles this channel",
    },
    {
      command: slackSlashCommands.STATUS,
      description: "Show current agent for this channel",
    },
    {
      command: slackSlashCommands.HELP,
      description: "Show available commands",
    },
  ].map((command) =>
    isSocket ? command : { ...command, url: slashCommandUrl },
  );

  const manifest = {
    display_information: {
      name: appName,
      description: `${appName} AI Agent`,
    },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: appName,
        always_online: true,
      },
      assistant_view: {
        assistant_description: `Your AI-powered ${appName} assistant`,
      },
      slash_commands: slashCommands,
    },
    oauth_config: {
      scopes: {
        bot: SLACK_REQUIRED_BOT_SCOPES,
      },
    },
    settings: {
      event_subscriptions: isSocket
        ? {
            bot_events: [
              "app_mention",
              "assistant_thread_started",
              "assistant_thread_context_changed",
              "message.channels",
              "message.groups",
              "message.im",
            ],
          }
        : {
            request_url: webhookUrl,
            bot_events: [
              "app_mention",
              "assistant_thread_started",
              "assistant_thread_context_changed",
              "message.channels",
              "message.groups",
              "message.im",
            ],
          },
      interactivity: isSocket
        ? { is_enabled: true }
        : { is_enabled: true, request_url: interactiveUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: isSocket,
      token_rotation_enabled: false,
    },
  };
  return JSON.stringify(manifest, null, 2);
}
