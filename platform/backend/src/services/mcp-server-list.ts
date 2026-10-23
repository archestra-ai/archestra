import McpServerModel from "@/models/mcp-server";
import McpServerAlertMuteModel from "@/models/mcp-server-alert-mute";
import type { McpServer } from "@/types";

/**
 * What every install listing adds for its caller: the caller's own alert
 * dismissals and whether the caller may use the install's credential. Shared
 * by `GET /api/mcp_server` and the registry's paged list, which returns the
 * installs of its page in the same shape.
 */
export async function decorateMcpServerListEntries<
  T extends McpServer,
>(params: { servers: T[]; userId: string }) {
  const { servers, userId } = params;
  const [alertMutesByCatalogId, credentialUsableIds] = await Promise.all([
    McpServerAlertMuteModel.findForViewer({
      userId,
      catalogIds: [...new Set(servers.map((server) => server.catalogId))],
    }),
    McpServerModel.getCredentialUsableServerIds(
      userId,
      servers.map((server) => server.id),
    ),
  ]);
  return servers.map((server) => ({
    ...server,
    alertMutes: (alertMutesByCatalogId.get(server.catalogId) ?? []).filter(
      (mute) => mute.mcpServerId === server.id,
    ),
    canUseCredential: credentialUsableIds.has(server.id),
  }));
}
