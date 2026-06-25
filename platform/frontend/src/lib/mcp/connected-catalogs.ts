import type { ResourceVisibilityScope } from "@archestra/shared";

/**
 * Catalog ids the given user can actually *use* a connected server for — the
 * same owner/team/org resolution the MCP gateway applies when picking a
 * credential. A server the user can merely *see* does not count: admins (and
 * MCP-server admins) receive every org server unfiltered, including other
 * users' personal installs, and treating those as "connected" would flip an
 * install prompt to success even though the failed tool call still can't
 * resolve a usable credential.
 *
 * Personal servers therefore only count when owned by the current user; team
 * and org servers count (non-admins already only see team servers for their own
 * teams, and org servers are usable by everyone).
 */
export function getUsableConnectedCatalogIds(params: {
  servers:
    | ReadonlyArray<{
        catalogId: string | null;
        scope: ResourceVisibilityScope;
        ownerId: string | null;
      }>
    | undefined;
  currentUserId: string | undefined;
}): Set<string> {
  const { servers, currentUserId } = params;
  const catalogIds = new Set<string>();
  for (const server of servers ?? []) {
    if (!server.catalogId) {
      continue;
    }
    const usableByCurrentUser =
      server.scope !== "personal" || server.ownerId === currentUserId;
    if (usableByCurrentUser) {
      catalogIds.add(server.catalogId);
    }
  }
  return catalogIds;
}
