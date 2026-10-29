import type { archestraApiTypes } from "@archestra/shared";

type InternalAgent =
  archestraApiTypes.GetChatAgentRosterResponses["200"][number];

type InitialAgentListItem = Pick<
  InternalAgent,
  | "id"
  | "name"
  | "scope"
  | "authorId"
  | "description"
  | "icon"
  | "runtime"
  | "builtIn"
>;

export function filterAndSortInitialAgents<
  T extends InitialAgentListItem,
>(params: {
  allAgents: T[];
  currentAgentId: string | null;
  search: string;
  userId?: string;
}): T[] {
  const { allAgents, currentAgentId, search, userId } = params;

  let result = allAgents.filter((agent) => {
    if (agent.builtIn) return false;
    if (agent.scope === "personal") {
      return agent.authorId === userId;
    }
    return true;
  });

  if (search) {
    const lower = search.toLowerCase();
    result = result.filter(
      (agent) =>
        agent.name.toLowerCase().includes(lower) ||
        agent.description?.toLowerCase().includes(lower),
    );
  }

  return [...result].sort((a, b) => {
    if (a.id === currentAgentId) return -1;
    if (b.id === currentAgentId) return 1;

    const aIsMyPersonalAgent =
      a.scope === "personal" && a.authorId === userId ? 1 : 0;
    const bIsMyPersonalAgent =
      b.scope === "personal" && b.authorId === userId ? 1 : 0;

    if (aIsMyPersonalAgent !== bIsMyPersonalAgent) {
      return bIsMyPersonalAgent - aIsMyPersonalAgent;
    }
    if (getScopeOrder(a.scope) !== getScopeOrder(b.scope)) {
      return getScopeOrder(a.scope) - getScopeOrder(b.scope);
    }

    return a.name.localeCompare(b.name);
  });
}

/**
 * Splits the picker's sorted list into the user's own agents and the ones
 * shared with them, keeping each group in the sorted order. Empty groups are
 * dropped so the picker never shows a heading with nothing under it.
 */
export function groupInitialAgents<T extends InitialAgentListItem>(params: {
  agents: T[];
  userId?: string;
  /** The user's pins, newest first; pinned agents lead in that order. */
  pinnedIds?: readonly string[];
}): { label: string; agents: T[] }[] {
  const { agents, userId, pinnedIds = [] } = params;
  const pinOrder = new Map(pinnedIds.map((id, index) => [id, index]));
  const pinned = agents
    .filter((agent) => pinOrder.has(agent.id))
    .sort((a, b) => (pinOrder.get(a.id) ?? 0) - (pinOrder.get(b.id) ?? 0));
  const unpinned = agents.filter((agent) => !pinOrder.has(agent.id));
  const yours = unpinned.filter(
    (agent) => agent.scope === "personal" && agent.authorId === userId,
  );
  const shared = unpinned.filter((agent) => !yours.includes(agent));
  return [
    { label: "Pinned", agents: pinned },
    { label: "Yours", agents: yours },
    { label: "Shared with you", agents: shared },
  ].filter((group) => group.agents.length > 0);
}

function getScopeOrder(scope: InitialAgentListItem["scope"]) {
  switch (scope) {
    case "personal":
      return 0;
    case "team":
      return 1;
    case "org":
      return 2;
    default:
      return 3;
  }
}
