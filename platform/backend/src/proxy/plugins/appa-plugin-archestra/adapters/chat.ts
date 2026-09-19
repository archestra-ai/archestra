import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import type { AppaClientAdapter } from "../types";

/** Maps the proxy-authenticated Chat call path without inferring client authority. */
export class AppaChatAdapter implements AppaClientAdapter {
  readonly id = "archestra-chat" as const;
  readonly reviewChannel = "host" as const;
  readonly supportsHitl = true;

  matches(context: Parameters<AppaClientAdapter["matches"]>[0]): boolean {
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
}
