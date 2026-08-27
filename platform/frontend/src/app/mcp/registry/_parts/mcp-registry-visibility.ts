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
};

export type McpRegistryOwnershipFilters = {
  scope?: "personal" | "team" | "org";
  teamIds?: string[];
  authorIds?: string[];
  excludeAuthorIds?: string[];
  excludeOtherPersonal?: true;
};

export function isMcpRegistryInstallUsableByViewer(
  server: McpRegistryVisibilityInstall,
  currentUserId: string | undefined,
): boolean {
  if (server.scope === "team" || server.scope === "org") return true;
  return !!currentUserId && server.ownerId === currentUserId;
}

export function mcpRegistryInstallPriority(
  server: McpRegistryVisibilityInstall,
  currentUserId: string | undefined,
): number {
  if (server.scope === "personal" && server.ownerId === currentUserId) return 0;
  if (server.scope === "team") return 1;
  if (server.scope === "org") return 2;
  return 3;
}

export function hasMcpRegistryInstallForViewer(
  servers: readonly McpRegistryVisibilityInstall[],
  currentUserId: string | undefined,
): boolean {
  return servers.some((server) =>
    isMcpRegistryInstallUsableByViewer(server, currentUserId),
  );
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
  const usableInstall = hasMcpRegistryInstallForViewer(servers, currentUserId);
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
