type InstallScope = "personal" | "team" | "org";

/**
 * Whether an install is the viewer's own personal connection — the only kind
 * the registry's Uninstall removes. Team and organization installs record
 * their installer as owner too, so ownership alone does not make an install
 * personal: removing a shared install is an installation-admin action from
 * the connections list.
 */
export function isOwnPersonalInstall(
  server: {
    ownerId: string | null;
    teamId: string | null;
    scope?: InstallScope;
  },
  userId: string | undefined,
): boolean {
  if (!userId || server.ownerId !== userId) return false;
  return resolveInstallScope(server) === "personal";
}

/**
 * The agents that lose access when this one install is removed. Removing a
 * shared install affects every agent assigned the server's tools, since any
 * caller may resolve to it. Nobody but its owner resolves to a personal
 * install, so removing one only affects agents pinned to it; agents with
 * unpinned assignments keep resolving to the other installs.
 */
export function agentsLosingAccessOnUninstall<
  Agent extends { pinned: boolean },
>(install: {
  server: { teamId?: string | null; scope?: InstallScope };
  assignedAgents?: Agent[];
}): Agent[] {
  const agents = install.assignedAgents ?? [];
  return resolveInstallScope(install.server) === "personal"
    ? agents.filter((agent) => agent.pinned)
    : agents;
}

/**
 * Who loses the connection, for the uninstall confirmation. Null for a
 * personal connection when the viewer sees no shared ones: there is nothing
 * for it to be told apart from.
 */
export function uninstallConsequence(
  server: { teamId?: string | null; scope?: InstallScope },
  seesSharedInstalls: boolean,
): string | null {
  switch (resolveInstallScope(server)) {
    case "personal":
      return seesSharedInstalls
        ? "Only this personal connection is removed; team and organization connections are not affected."
        : null;
    case "team":
      return "This removes the team connection for everyone on the team.";
    case "org":
      return "This removes the organization-wide connection for everyone in the organization.";
  }
}

// ===

function resolveInstallScope(server: {
  teamId?: string | null;
  scope?: InstallScope;
}): InstallScope {
  return server.scope ?? (server.teamId ? "team" : "personal");
}
