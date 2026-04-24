import { urlSlugify } from "./utils";

/**
 * Slack bot scopes required by the Archestra Slack app.
 *
 * This is the single source of truth used by:
 * - The Slack app manifest builder (frontend setup dialog)
 * - Runtime scope validation (backend SlackProvider)
 *
 * When adding a new scope, add it here and it will automatically
 * appear in both the manifest and the scope-drift detection.
 */
export const SLACK_REQUIRED_BOT_SCOPES = [
  "assistant:write",
  "commands",
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "files:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
  "users:read.email",
] as const;

/**
 * Native Slack slash commands.
 *
 * Slack command names are generated from the app name in the setup manifest,
 * but the command suffixes are stable so the backend can route any app-name
 * prefix to the right action.
 */
export const SLACK_SLASH_COMMAND_SUFFIXES = {
  SELECT_AGENT: "-select-agent",
  STATUS: "-status",
  HELP: "-help",
} as const;

export type SlackSlashCommandAction = keyof typeof SLACK_SLASH_COMMAND_SUFFIXES;

export const SLACK_SLASH_COMMANDS = buildSlackSlashCommands("Archestra");

export function buildSlackSlashCommands(
  appName: string,
): Record<SlackSlashCommandAction, string> {
  const commandPrefix = urlSlugify(appName) || "archestra";

  return {
    SELECT_AGENT: `/${commandPrefix}${SLACK_SLASH_COMMAND_SUFFIXES.SELECT_AGENT}`,
    STATUS: `/${commandPrefix}${SLACK_SLASH_COMMAND_SUFFIXES.STATUS}`,
    HELP: `/${commandPrefix}${SLACK_SLASH_COMMAND_SUFFIXES.HELP}`,
  };
}

export function getSlackSlashCommandAction(
  command: string | undefined,
): SlackSlashCommandAction | null {
  const normalizedCommand = command?.trim().toLowerCase();
  if (!normalizedCommand?.startsWith("/")) return null;

  for (const [action, suffix] of Object.entries(SLACK_SLASH_COMMAND_SUFFIXES)) {
    const hasPrefix = normalizedCommand.length > suffix.length + 1;
    if (hasPrefix && normalizedCommand.endsWith(suffix)) {
      return action as SlackSlashCommandAction;
    }
  }

  return null;
}

export function buildSlackSlashCommandsForCommand(
  command: string | undefined,
): Record<SlackSlashCommandAction, string> {
  const normalizedCommand = command?.trim().toLowerCase();
  const suffix = Object.values(SLACK_SLASH_COMMAND_SUFFIXES).find((value) =>
    normalizedCommand?.endsWith(value),
  );

  if (!normalizedCommand?.startsWith("/") || !suffix) {
    return SLACK_SLASH_COMMANDS;
  }

  const commandPrefix = normalizedCommand.slice(0, -suffix.length);
  return {
    SELECT_AGENT: `${commandPrefix}${SLACK_SLASH_COMMAND_SUFFIXES.SELECT_AGENT}`,
    STATUS: `${commandPrefix}${SLACK_SLASH_COMMAND_SUFFIXES.STATUS}`,
    HELP: `${commandPrefix}${SLACK_SLASH_COMMAND_SUFFIXES.HELP}`,
  };
}
