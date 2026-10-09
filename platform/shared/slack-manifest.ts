import { buildSlackSlashCommands, SLACK_REQUIRED_BOT_SCOPES } from "./slack";

type SlackManifestConnectionMode = "socket" | "webhook";

/**
 * The bot events an Archestra Slack app subscribes to. agent_session_stopped
 * makes Slack show the Stop button; app_home_opened is when a DM opens (for
 * suggested prompts).
 */
const SLACK_BOT_EVENTS = [
  "agent_session_stopped",
  "app_home_opened",
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
] as const;

export function buildSlackManifest(params: {
  appName: string;
  connectionMode: SlackManifestConnectionMode;
  webhookUrl: string;
  interactiveUrl: string;
  slashCommandUrl: string;
  /**
   * Off for a Slack bot pinned to one agent: the main app owns the commands,
   * and two apps registering the same command names would clash.
   */
  slashCommands?: boolean;
  /**
   * OAuth redirect URLs, for an app Archestra creates and installs itself.
   * Slack accepts only HTTPS ones.
   */
  redirectUrls?: string[];
}): string {
  const {
    appName,
    connectionMode,
    webhookUrl,
    interactiveUrl,
    slashCommandUrl,
  } = params;
  const isSocket = connectionMode === "socket";
  const includeSlashCommands = params.slashCommands ?? true;
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
      // The Agent messaging experience: agent sessions with a Stop button,
      // streamed replies, and suggested prompts in the Messages tab.
      agent_view: {
        agent_description: `Your AI-powered ${appName} assistant`,
      },
      ...(includeSlashCommands && { slash_commands: slashCommands }),
    },
    oauth_config: {
      scopes: {
        bot: SLACK_REQUIRED_BOT_SCOPES,
      },
      ...(params.redirectUrls?.length && {
        redirect_urls: params.redirectUrls,
      }),
    },
    settings: {
      event_subscriptions: isSocket
        ? {
            bot_events: [...SLACK_BOT_EVENTS],
          }
        : {
            request_url: webhookUrl,
            bot_events: [...SLACK_BOT_EVENTS],
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

/**
 * Bring an existing app's manifest (as Slack exports it) up to what Archestra
 * needs now, changing nothing else: the agent experience instead of the
 * assistant one, the current bot events, and the current bot scopes. Names,
 * icons, URLs, slash commands, and anything an admin added stay as they are.
 */
export function migrateSlackManifest(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const features = { ...(manifest.features as Record<string, unknown>) };
  const assistantView = features.assistant_view as
    | { assistant_description?: string }
    | undefined;
  const agentView = features.agent_view as
    | { agent_description?: string }
    | undefined;
  const displayName = (
    manifest.display_information as { name?: string } | undefined
  )?.name;
  delete features.assistant_view;
  features.agent_view = {
    ...agentView,
    agent_description:
      agentView?.agent_description ??
      assistantView?.assistant_description ??
      `Your AI-powered ${displayName ?? "Slack"} assistant`,
  };

  const oauthConfig = manifest.oauth_config as
    | { scopes?: Record<string, unknown> }
    | undefined;
  const settings = manifest.settings as
    | { event_subscriptions?: Record<string, unknown> }
    | undefined;

  return {
    ...manifest,
    features,
    oauth_config: {
      ...oauthConfig,
      scopes: { ...oauthConfig?.scopes, bot: [...SLACK_REQUIRED_BOT_SCOPES] },
    },
    settings: {
      ...settings,
      event_subscriptions: {
        ...settings?.event_subscriptions,
        bot_events: [...SLACK_BOT_EVENTS],
      },
    },
  };
}
