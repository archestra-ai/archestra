import type { MsTeamsDbConfig } from "@/types";

/**
 * Whether a Microsoft Teams configuration can connect: enabled, with an app ID
 * and secret. It lives apart from the provider so that callers can ask without
 * loading the provider, which imports the Microsoft Graph SDKs (about 90 MB).
 */
export function isMsTeamsConfigured(
  config: Pick<MsTeamsDbConfig, "enabled" | "appId" | "appSecret">,
): boolean {
  return config.enabled && Boolean(config.appId) && Boolean(config.appSecret);
}
