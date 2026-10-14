import type { archestraApiTypes } from "@archestra/shared";

type InternalAgent =
  archestraApiTypes.GetAgentsResponses["200"]["data"][number];

type InitialAgentListItem = Pick<
  InternalAgent,
  | "id"
  | "name"
  | "scope"
  | "authorId"
  | "description"
  | "icon"
  | "systemPrompt"
  | "runtime"
  | "builtIn"
>;

/**
 * The client-side half of the picker's search, for the pinned rows it already
 * holds; the paginated rows are matched the same way on the server.
 */
export function matchesAgentSearch(
  agent: Pick<InitialAgentListItem, "name" | "description">,
  search: string,
): boolean {
  const lower = search.trim().toLowerCase();
  if (!lower) return true;
  return (
    agent.name.toLowerCase().includes(lower) ||
    (agent.description?.toLowerCase().includes(lower) ?? false)
  );
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
