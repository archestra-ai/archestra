import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import type {
  AppaClientAdapter,
  AppaSessionIdentityResolution,
  AppaToolCall,
  AppaToolResult,
} from "../types";

/** Maps the proxy-authenticated Chat call path without inferring client authority. */
export class AppaChatAdapter implements AppaClientAdapter {
  readonly id = "archestra-chat" as const;
  readonly nativeClient = "unknown" as const;
  readonly protocol = "chat_completions" as const;

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

  resolveSessionIdentity(): AppaSessionIdentityResolution {
    return null;
  }

  isNativeSpawnTool(): boolean {
    return false;
  }

  unsupportedNativeLifecycleReason(): string | null {
    return null;
  }

  extractCarrierChild(): null {
    return null;
  }

  extractToolCalls(): AppaToolCall[] {
    return [];
  }

  rewriteToolCalls(responseBody: unknown): unknown {
    return responseBody;
  }

  extractToolResults(): AppaToolResult[] {
    return [];
  }

  formatToolResult(result: AppaToolResult): unknown {
    return result.content;
  }
}
