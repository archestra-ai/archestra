import type { CreateConnectionSetupBody } from "@/lib/connection-setup.query";

/** Target OS for the generated setup command (matches the backend enum). */
export type ConnectPlatform = NonNullable<
  CreateConnectionSetupBody["platform"]
>;

/**
 * The selectable options. macOS and Linux render the identical `curl | bash`
 * script, so they collapse into one choice (sent to the API as "macos");
 * Windows gets the PowerShell renderer.
 */
export const CONNECT_PLATFORM_OPTIONS = ["macos", "windows"] as const;
export type ConnectPlatformOption = (typeof CONNECT_PLATFORM_OPTIONS)[number];

export const platformLabels: Record<ConnectPlatformOption, string> = {
  macos: "macOS / Linux",
  windows: "Windows",
};

/** Collapse a detected OS onto a selectable option (linux folds into macOS). */
export function toPlatformOption(
  platform: ConnectPlatform,
): ConnectPlatformOption {
  return platform === "windows" ? "windows" : "macos";
}

/**
 * Best-effort OS detection from the browser so the wizard pre-selects the
 * platform the user is most likely setting up. Falls back to macOS (the bash
 * default) when nothing matches or when called outside the browser. The user
 * can always override the choice in the review step.
 */
export function detectPlatform(): ConnectPlatform {
  if (typeof navigator === "undefined") return "macos";
  const uaData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  const raw = (
    uaData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    ""
  ).toLowerCase();

  // macOS/darwin must come before the "win" check: "darwin" contains "win".
  if (
    raw.includes("mac") ||
    raw.includes("darwin") ||
    raw.includes("iphone") ||
    raw.includes("ipad")
  ) {
    return "macos";
  }
  if (raw.includes("win")) return "windows";
  if (raw.includes("linux") || raw.includes("android") || raw.includes("x11")) {
    return "linux";
  }
  return "macos";
}
