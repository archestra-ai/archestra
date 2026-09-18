import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import type { AppaClientAdapter, AppaMatchContext } from "../types";

/** Maps the proxy-authenticated Chat call path without inferring client authority. */
export class AppaChatAdapter implements AppaClientAdapter {
  readonly id = "archestra-chat" as const;
  readonly trajectoryPrefix = "chat";

  matches(context: AppaMatchContext): boolean {
    return context.trustedContext?.chatSource !== undefined;
  }

  classifyToolName(name: string): "gateway" | "local" {
    // Chat uses the platform's strict branding authority so white-label tool
    // names and the gateway's own recognized built-ins stay aligned.
    return archestraMcpBranding.isToolName(name) ? "gateway" : "local";
  }

  normalizeLocalToolName(name: string): string {
    return name;
  }

  isSpawnTool(_name: string): boolean {
    return false;
  }

  namesChildren(_params: { rootId: string; arguments: unknown }): string[] {
    return [];
  }

  bindChildTrajectory(_context: AppaMatchContext) {
    return undefined;
  }
}
