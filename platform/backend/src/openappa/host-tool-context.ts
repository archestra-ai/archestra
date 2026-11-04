import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import type { HostToolContext } from "./host-tool-rules";

/** What this deployment's host tool rules depend on now. */
export function hostToolContext(): HostToolContext {
  return { serverName: archestraMcpBranding.serverName, gitSyncAudience: null };
}
