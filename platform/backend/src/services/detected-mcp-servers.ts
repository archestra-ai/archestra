import { clientForExternalAgentIds } from "@archestra/shared";
import { ToolObservationModel } from "@/models";
import type { ProxyToolObservation } from "@/models/tool-observation";
import type { DetectedMcpServer } from "@/types";
import {
  DETECTED_CLIENT_FAMILIES,
  type DetectedClientFamily,
  detectedServerId,
  isDetectedClientFamily,
  parseDetectedToolName,
} from "@/utils/detected-mcp-server-names";

/**
 * The organization's detected MCP servers, derived from the proxy's tool
 * observations: an observation ties a proxy-discovered tool to the member
 * who declared it and to their client. Every local server under one label,
 * in any client and for any member, is one detected server: an attachment
 * made to it governs that label for everyone.
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
    DetectedMcpServer & {
      toolNames: Set<string>;
      families: Set<DetectedClientFamily>;
    }
  >();
  for (const observation of observations) {
    const family = clientFamilyOf(observation.externalAgentId);
    if (!family) continue;
    const parsed = parseDetectedToolName(family, observation.toolName);
    if (!parsed) continue;
    const id = detectedServerId(parsed.label);
    let server = servers.get(id);
    if (!server) {
      server = {
        id,
        label: parsed.label,
        clientFamilies: [],
        tools: [],
        firstObservedAt: observation.observedAt,
        toolNames: new Set(),
        families: new Set(),
      };
      servers.set(id, server);
    }
    server.families.add(family);
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
    .map(({ toolNames: _toolNames, families, ...server }) => ({
      ...server,
      clientFamilies: DETECTED_CLIENT_FAMILIES.filter((family) =>
        families.has(family),
      ),
      tools: server.tools.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function clientFamilyOf(
  externalAgentId: string,
): DetectedClientFamily | undefined {
  const family = clientForExternalAgentIds([externalAgentId])?.filter;
  return family && isDetectedClientFamily(family) ? family : undefined;
}
