import type { archestraApiTypes } from "@shared";

type InternalAgent = archestraApiTypes.GetAllAgentsResponses["200"][number];

type InitialAgentListItem = Pick<
  InternalAgent,
  "id" | "name" | "scope" | "authorId" | "description" | "icon" | "systemPrompt"
>;

export function filterAndSortInitialAgents(params: {
  allAgents: InitialAgentListItem[];
  currentAgentId: string | null;
  search: string;
  userId?: string;
}) {
  const { allAgents, currentAgentId, search, userId } = params;

  let result = allAgents.filter((agent) => {
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
    const aIsMyPersonalAgent =
      a.scope === "personal" && a.authorId === userId ? 1 : 0;
    const bIsMyPersonalAgent =
      b.scope === "personal" && b.authorId === userId ? 1 : 0;

    if (aIsMyPersonalAgent !== bIsMyPersonalAgent) {
      return bIsMyPersonalAgent - aIsMyPersonalAgent;
    }
    if (a.id === currentAgentId) return -1;
    if (b.id === currentAgentId) return 1;
    if (getScopeOrder(a.scope) !== getScopeOrder(b.scope)) {
      return getScopeOrder(a.scope) - getScopeOrder(b.scope);
    }

    return a.name.localeCompare(b.name);
  });
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
