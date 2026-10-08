import {
  CLAUDE_CLIENT_FILTER,
  type ClientFilter,
  clientFilterToAgentIds,
  clientForExternalAgentIds,
  OPENCODE_MCP_TOOL_NAME_PREFIX,
} from "@archestra/shared";
import { ToolObservationModel } from "@/models";
import type { ProxyToolObservation } from "@/models/tool-observation";
import {
  declaredDetectedTargets,
  openCodeLabelsOf,
} from "@/openappa/detected-targets";
import type { DetectedMcpServer } from "@/types";
import {
  type DetectedClientFamily,
  detectedServerId,
  isDetectedClientFamily,
  parseDetectedServerId,
  parseDetectedToolName,
} from "@/utils/detected-mcp-server-names";

/**
 * The organization's detected MCP servers, derived from the proxy's tool
 * observations: an observation ties a proxy-discovered tool to the member
 * who declared it and to their client. Two members whose local servers
 * share a label share one detected server: an attachment made to it governs
 * that label for everyone.
 */
export async function listDetectedMcpServers(
  organizationId: string,
  options: { openCodeLabels?: readonly string[] } = {},
): Promise<DetectedMcpServer[]> {
  const [observations, openCodeLabels] = await Promise.all([
    ToolObservationModel.listProxyToolObservations(organizationId),
    options.openCodeLabels ?? declaredOpenCodeLabels(organizationId),
  ]);
  return groupDetectedServers(observations, openCodeLabels);
}

/**
 * One detected server by id, read from the observations of its client family
 * whose tool names carry its label, or null when the organization has none.
 */
export async function findDetectedMcpServer(
  organizationId: string,
  id: string,
): Promise<DetectedMcpServer | null> {
  const parsed = parseDetectedServerId(id);
  if (!parsed) return null;
  const label = escapeLike(parsed.label);
  const observations = await ToolObservationModel.listProxyToolObservations(
    organizationId,
    {
      externalAgentIds: clientFilterToAgentIds(clientFilterOf(parsed.family)),
      toolNameLike:
        parsed.family === "opencode"
          ? [`${OPENCODE_MCP_TOOL_NAME_PREFIX}${label}:%`, `${label}\\_%`]
          : [`mcp\\_\\_${label}\\_\\_%`],
    },
  );
  const openCodeLabels = parsed.family === "opencode" ? [parsed.label] : [];
  return (
    groupDetectedServers(observations, openCodeLabels).find(
      (server) => server.id === id,
    ) ?? null
  );
}

// === Internal helpers ===

function clientFilterOf(family: DetectedClientFamily): ClientFilter {
  return family === "claude-code" ? CLAUDE_CLIENT_FILTER : family;
}

/** A literal for a LIKE pattern whose escape character is `\`. */
function escapeLike(literal: string): string {
  return literal.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * OpenCode spells a local tool `<label>_<tool>`, which only a declared
 * `opencode.<label>` alias target can split; the policy is the one source of
 * those labels. Nothing is learned from the names themselves. A caller that
 * already holds one policy revision's targets passes their labels instead, so
 * what it derives does not straddle two revisions.
 */
async function declaredOpenCodeLabels(
  organizationId: string,
): Promise<string[]> {
  return openCodeLabelsOf(await declaredDetectedTargets(organizationId));
}

function groupDetectedServers(
  observations: ProxyToolObservation[],
  openCodeLabels: readonly string[],
): DetectedMcpServer[] {
  const servers = new Map<
    string,
    DetectedMcpServer & { toolNames: Set<string> }
  >();
  // Observations repeat one (client, tool name) once per member and per
  // sighting; the name is parsed once per such pair.
  const parsedByName = new Map<
    string,
    ReturnType<typeof parseDetectedToolName>
  >();
  for (const observation of observations) {
    const family = clientFamilyOf(observation.externalAgentId);
    if (!family) continue;
    const nameKey = `${family}\u0000${observation.toolName}`;
    let parsed = parsedByName.get(nameKey);
    if (!parsedByName.has(nameKey)) {
      parsed = parseDetectedToolName(
        family,
        observation.toolName,
        openCodeLabels,
      );
      parsedByName.set(nameKey, parsed);
    }
    if (!parsed) continue;
    const id = detectedServerId(family, parsed.label);
    let server = servers.get(id);
    if (!server) {
      server = {
        id,
        label: parsed.label,
        clientFamily: family,
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

function clientFamilyOf(
  externalAgentId: string,
): DetectedClientFamily | undefined {
  const family = clientForExternalAgentIds([externalAgentId])?.filter;
  return family && isDetectedClientFamily(family) ? family : undefined;
}
