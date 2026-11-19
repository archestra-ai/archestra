/**
 * Narrowing a server's connections — its credentials or installations — by
 * kind and by who they belong to.
 */

export type ConnectionFilter = "all" | "needs-sign-in" | "personal" | "shared";

/** What the filters read from a connection, whatever its row shows. */
export interface FilterableConnection {
  /** The owner's email, the team's name, or "Organization". */
  owner: string;
  /** Who created a shared connection; null for a personal one. */
  createdBy: string | null;
  needsSignIn: boolean;
  /** Shared with a team or the organization, rather than personal. */
  shared: boolean;
}

export function matchesConnectionFilter(
  connection: FilterableConnection,
  filter: ConnectionFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "needs-sign-in":
      return connection.needsSignIn;
    case "personal":
      return !connection.shared;
    case "shared":
      return connection.shared;
  }
}

/** Matches the owner, or the creator of a shared connection, ignoring case. */
export function matchesConnectionSearch(
  connection: FilterableConnection,
  query: string,
): boolean {
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return (
    connection.owner.toLowerCase().includes(term) ||
    (connection.createdBy ?? "").toLowerCase().includes(term)
  );
}

export function countConnectionFilters(
  connections: readonly FilterableConnection[],
): Record<ConnectionFilter, number> {
  const counts: Record<ConnectionFilter, number> = {
    all: 0,
    "needs-sign-in": 0,
    personal: 0,
    shared: 0,
  };
  for (const connection of connections) {
    for (const filter of Object.keys(counts) as ConnectionFilter[]) {
      if (matchesConnectionFilter(connection, filter)) counts[filter] += 1;
    }
  }
  return counts;
}
