import type { SetupScriptMcpSection } from "../types";

/**
 * Server names this gateway may already sit under in the client's config,
 * minus the one it is about to be registered as.
 */
export function legacyServerNames(mcp: SetupScriptMcpSection): string[] {
  return (mcp.legacyServerNames ?? []).filter(
    (name) => name && name !== mcp.serverName,
  );
}
