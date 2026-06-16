import type { CreateConnectionSetupBody } from "@/lib/connection-setup.query";

/** Target OS for the generated setup command (matches the backend enum). */
export type ConnectPlatform = NonNullable<
  CreateConnectionSetupBody["platform"]
>;

export const CONNECT_PLATFORMS: readonly ConnectPlatform[] = [
  "macos",
  "linux",
  "windows",
];

export const platformLabels: Record<ConnectPlatform, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

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
