import type { DetectedMcpServer } from "@/lib/mcp/detected-mcp-server.query";

/**
 * The detected servers the registry shows for a search: the search box
 * matches a server's label, as it matches a catalog entry's name, and the
 * list is ordered by label so one server connected through two clients sits
 * on adjacent cards.
 */
export function filterDetectedServers(
  servers: DetectedMcpServer[],
  query: string,
): DetectedMcpServer[] {
  const normalizedQuery = query.trim().toLowerCase();
  return servers
    .filter(
      (server) =>
        !normalizedQuery ||
        server.label.toLowerCase().includes(normalizedQuery),
    )
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label) ||
        a.clientFamily.localeCompare(b.clientFamily),
    );
}
