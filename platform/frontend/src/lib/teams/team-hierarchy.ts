export type TeamHierarchyNode = {
  id: string;
  name: string;
  parentId?: string | null;
  descendantTeams?: Array<{ id: string; name: string }>;
};

export function getTeamDescendantIds(
  teams: TeamHierarchyNode[],
  teamId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const team of teams) {
    if (!team.parentId) continue;
    const children = childrenByParent.get(team.parentId) ?? [];
    children.push(team.id);
    childrenByParent.set(team.parentId, children);
  }

  const descendants: string[] = [];
  const visited = new Set([teamId]);
  const queue = [...(childrenByParent.get(teamId) ?? [])];
  for (const id of queue) {
    if (visited.has(id)) continue;
    visited.add(id);
    descendants.push(id);
    queue.push(...(childrenByParent.get(id) ?? []));
  }
  return descendants;
}

export function formatTeamPath(
  teams: TeamHierarchyNode[],
  teamId: string,
): string {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const path: string[] = [];
  const visited = new Set<string>();
  let current = teamById.get(teamId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current.name);
    current = current.parentId ? teamById.get(current.parentId) : undefined;
  }
  return path.join(" / ");
}
