import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import type { AppaClientAdapter, AppaMatchContext } from "../types";
import { withoutCallerScope } from "../utils";
import {
  bindInProcessChild,
  inProcessSpawnPromptField,
  isInProcessDelegationTool,
} from "./in-process-executor";

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

  isSpawnTool(name: string): boolean {
    return isInProcessDelegationTool(name);
  }

  spawnPromptField(name: string, _args: Record<string, unknown>) {
    return inProcessSpawnPromptField(name);
  }

  nativeConversationId(context: AppaMatchContext): string | undefined {
    const session = context.trustedContext?.session;
    if (!session) return undefined;
    return withoutCallerScope(session, session.session_id);
  }

  namesChildren(_params: { rootId: string; arguments: unknown }): string[] {
    return [];
  }

  bindChildTrajectory(context: AppaMatchContext) {
    return bindInProcessChild(context);
  }

  stripCarrierMetadata(_request: unknown): void {}
}
