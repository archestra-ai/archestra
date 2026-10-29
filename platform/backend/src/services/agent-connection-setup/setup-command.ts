import type { ConnectionSetupPlatform } from "@/types";
import { psq, sh } from "./steps/quoting";

/**
 * The one-liner shown in the UI. `origin` is the API origin (no /v1). Windows
 * gets a PowerShell `irm | iex` invocation; macOS/Linux get `curl | bash`.
 */
export function buildSetupCommand(params: {
  origin: string;
  rawToken: string;
  platform: ConnectionSetupPlatform;
}): string {
  const url = `${params.origin}/api/connection-setups/script/${params.rawToken}`;
  if (params.platform === "windows") {
    // single quotes: nothing in the URL may expand in PowerShell.
    return `irm ${psq(url)} | iex`;
  }
  // single quotes: nothing in the URL may expand in the user's shell.
  return `curl -fsSL ${sh(url)} | bash`;
}

/** Strips the /v1 suffix the connection base URLs carry. */
export function proxyBaseUrlToOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}
