import { clientForExternalAgentIds } from "@archestra/shared";
import { ToolObservationModel } from "@/models";
import type { ProxyToolObservation } from "@/models/tool-observation";
import type { DetectedMcpServer } from "@/types";
import {
  type DetectedClientFamily,
  detectedServerId,
  isDetectedClientFamily,
  parseDetectedToolName,
} from "@/utils/detected-mcp-server-names";

/**
 * The organization's detected MCP servers, derived from the proxy's tool
 * observations. Two members whose local servers share a label share one
 * detected server: an attachment made to it governs that label for everyone.
 */
export async function listDetectedMcpServers(
  organizationId: string,
): Promise<DetectedMcpServer[]> {
  const observations =
    await ToolObservationModel.listProxyToolObservations(organizationId);
  return groupDetectedServers(observations);
}

// === Internal helpers ===

function groupDetectedServers(
  observations: ProxyToolObservation[],
): DetectedMcpServer[] {
  const servers = new Map<
    string,
    DetectedMcpServer & { observers: Set<string>; toolIds: Set<string> }
  >();
  for (const observation of observations) {
    const family = clientFamilyOf(observation.externalAgentId);
    if (!family) continue;
    const parsed = parseDetectedToolName(family, observation.toolName);
    if (!parsed) continue;
    const id = detectedServerId(family, parsed.label);
    let server = servers.get(id);
    if (!server) {
      server = {
        id,
        label: parsed.label,
        clientFamily: family,
        tools: [],
        observerCount: 0,
        firstObservedAt: observation.observedAt,
        observers: new Set(),
        toolIds: new Set(),
      };
      servers.set(id, server);
    }
    if (!server.toolIds.has(observation.toolId)) {
      server.toolIds.add(observation.toolId);
      server.tools.push({
        id: observation.toolId,
        name: observation.toolName,
        toolName: parsed.toolName,
        description: observation.toolDescription,
      });
    }
    server.observers.add(observation.userId);
    if (observation.observedAt < server.firstObservedAt) {
      server.firstObservedAt = observation.observedAt;
    }
  }
  return [...servers.values()]
    .map(({ observers, toolIds: _toolIds, ...server }) => ({
      ...server,
      tools: server.tools.sort((a, b) => a.name.localeCompare(b.name)),
      observerCount: observers.size,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function clientFamilyOf(
  externalAgentId: string,
): DetectedClientFamily | undefined {
  const family = clientForExternalAgentIds([externalAgentId])?.filter;
  return family && isDetectedClientFamily(family) ? family : undefined;
}
