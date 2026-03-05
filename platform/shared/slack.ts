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
