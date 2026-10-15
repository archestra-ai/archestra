import { useHasPermissions } from "@/lib/auth/auth.query";

/**
 * Whether the viewer sees every agent and MCP gateway using a server — the
 * rule the server uses to decide whose agents a server's usage may name: anyone
 * who manages shared installations, or holds organization-wide update on
 * agents or gateways. Anyone else (a member) sees only agents they can open,
 * so naming an agent's owner tells them nothing.
 *
 * Mirrors `getVisibleAgentFilter` in backend `routes/mcp-server.ts`, whose
 * agent-type admin check is update at `*` on the same two resources (`agent`,
 * `mcpGateway`); change both together.
 */
export function useSeesAllAgents(): boolean {
  const { data: sharedInstalls } = useHasPermissions({
    mcpServerInstallation: ["update"],
  });
  const { data: allAgents } = useHasPermissions({ agent: ["update"] }, "*");
  const { data: allGateways } = useHasPermissions(
    { mcpGateway: ["update"] },
    "*",
  );
  return !!sharedInstalls || !!allAgents || !!allGateways;
}
