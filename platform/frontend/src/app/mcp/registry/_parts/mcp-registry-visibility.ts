export type McpRegistryVisibilityItem = {
  id: string;
  scope: "personal" | "team" | "org";
  authorId?: string | null;
  teams?: Array<{ id: string }> | null;
};

export type McpRegistryVisibilityInstall = {
  catalogId: string | null;
  scope: "personal" | "team" | "org";
  ownerId?: string | null;
  teamId?: string | null;
  /**
   * The backend's per-viewer verdict: the viewer's own connection, one shared
   * with a team they belong to, or an organization-wide one. False for another
   * member's personal connection and for another team's connection, both of
   * which an admin's listing still returns.
   */
  canUseCredential: boolean;
};

export type McpRegistryOwnershipFilters = {
  scope?: "personal" | "team" | "org";
  teamIds?: string[];
  authorIds?: string[];
  excludeAuthorIds?: string[];
  excludeOtherPersonal?: true;
};

/**
 * The one answer to "is this MCP server installed for me?". The card's
 * Install button, the Installed / Not installed filter, the table's status and
 * Install action, and the server page's header status all read it, so they
 * cannot disagree about the same server.
 *
 * Installed means the viewer has a connection they can actually use: their
 * own personal one, one shared with a team they belong to, or an
 * organization-wide one. Installs that only appear because the viewer is an
 * admin — another member's personal connection, another team's connection —
 * do not count; the viewer still has to install the server to use it.
 *
 * Multi-tenant servers follow the same rule. They share one deployment, but
 * every member connects through an install row of their own (or a shared
 * one), so a colleague's row does not make the server installed for the
 * viewer.
 *
 * `servers` is every install of ONE catalog item the viewer can see.
 */
export function isMcpServerInstalledForViewer(
  servers: readonly Pick<McpRegistryVisibilityInstall, "canUseCredential">[],
): boolean {
  return servers.some((server) => server.canUseCredential);
}

export function mcpRegistryInstallPriority(
  server: McpRegistryVisibilityInstall,
  currentUserId: string | undefined,
): number {
  // An install the viewer cannot use never stands in for the catalog item
  // while one they can use exists.
  if (!server.canUseCredential) return 3;
  if (server.scope === "personal" && server.ownerId === currentUserId) return 0;
  if (server.scope === "team") return 1;
  if (server.scope === "org") return 2;
  return 3;
}

export function matchesMcpRegistryOwnershipFilters({
  item,
  servers,
  filters,
  currentUserId,
}: {
  item: McpRegistryVisibilityItem;
  servers: readonly McpRegistryVisibilityInstall[];
  filters: McpRegistryOwnershipFilters;
  currentUserId: string | undefined;
}): boolean {
  const usableInstall = isMcpServerInstalledForViewer(servers);
  const authoredByViewer = !!currentUserId && item.authorId === currentUserId;

  if (
    filters.excludeOtherPersonal &&
    item.scope === "personal" &&
    !usableInstall &&
    !authoredByViewer
  ) {
    return false;
  }

  if (filters.scope === "personal") {
    if (filters.authorIds?.length) {
      return (
        (!!item.authorId && filters.authorIds.includes(item.authorId)) ||
        servers.some(
          (server) =>
            server.scope === "personal" &&
            !!server.ownerId &&
            filters.authorIds?.includes(server.ownerId),
        )
      );
    }
    if (filters.excludeAuthorIds?.length) {
      const foreignCatalog =
        !item.authorId || !filters.excludeAuthorIds.includes(item.authorId);
      const foreignInstall = servers.some(
        (server) =>
          server.scope === "personal" &&
          (!server.ownerId ||
            !filters.excludeAuthorIds?.includes(server.ownerId)),
      );
      return item.scope === "personal"
        ? foreignCatalog || foreignInstall
        : foreignInstall;
    }
    return item.scope === "personal" || usableInstall;
  }

  if (filters.scope === "team") {
    const teamIds = filters.teamIds;
    const matchesTeam = (teamId: string | null | undefined) =>
      !!teamId && (!teamIds?.length || teamIds.includes(teamId));
    return (
      (item.scope === "team" &&
        (!teamIds?.length ||
          (item.teams ?? []).some((team) => matchesTeam(team.id)))) ||
      servers.some(
        (server) => server.scope === "team" && matchesTeam(server.teamId),
      )
    );
  }

  if (filters.scope === "org") {
    return (
      item.scope === "org" || servers.some((server) => server.scope === "org")
    );
  }

  return true;
}
