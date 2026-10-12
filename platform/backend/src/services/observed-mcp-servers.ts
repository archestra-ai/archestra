import { ToolObservationModel } from "@/models";
import type { ProxyToolObservation } from "@/models/tool-observation";
import type { ObservedMcpServer } from "@/types";
import {
  observedServerId,
  parseObservedToolName,
} from "@/utils/observed-mcp-server-names";

/**
 * The organization's observed MCP servers, derived from the proxy's tool
 * observations: an observation ties a proxy-discovered tool to the member
 * who declared it. Every local server under one label, for any member and
 * whichever client sent it, is one observed server: an attachment made to it
 * governs that label for everyone.
 */
export async function listObservedMcpServers(
  organizationId: string,
): Promise<ObservedMcpServer[]> {
  const observations =
    await ToolObservationModel.listProxyToolObservations(organizationId);
  return groupObservedServers(observations);
}

// === Internal helpers ===

function groupObservedServers(
  observations: ProxyToolObservation[],
): ObservedMcpServer[] {
  const servers = new Map<
    string,
    ObservedMcpServer & { toolNames: Set<string> }
  >();
  for (const observation of observations) {
    const parsed = parseObservedToolName(observation.toolName);
    if (!parsed) continue;
    const id = observedServerId(parsed.label);
    let server = servers.get(id);
    if (!server) {
      server = {
        id,
        label: parsed.label,
        tools: [],
        firstObservedAt: observation.observedAt,
        toolNames: new Set(),
      };
      servers.set(id, server);
    }
    // Two proxy requests can discover one name at once and leave two rows;
    // the server has one tool of that name.
    if (!server.toolNames.has(observation.toolName)) {
      server.toolNames.add(observation.toolName);
      server.tools.push({
        id: observation.toolId,
        name: observation.toolName,
        toolName: parsed.toolName,
      });
    }
    if (observation.observedAt < server.firstObservedAt) {
      server.firstObservedAt = observation.observedAt;
    }
  }
  return [...servers.values()]
    .map(({ toolNames: _toolNames, ...server }) => ({
      ...server,
      tools: server.tools.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
