import { clientForExternalAgentIds } from "@archestra/shared";
import config from "@/config";
import { ToolObservationModel } from "@/models";
import type { ProxyToolObservation } from "@/models/tool-observation";
import { openappaDeclarations } from "@/openappa/declarations";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
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
): Promise<DetectedMcpServer[]> {
  const [observations, openCodeLabels] = await Promise.all([
    ToolObservationModel.listProxyToolObservations(organizationId),
    declaredOpenCodeLabels(organizationId),
  ]);
  return groupDetectedServers(observations, openCodeLabels);
}

// === Internal helpers ===

/**
 * OpenCode spells a local tool `<label>_<tool>`, which only a declared
 * `opencode.<label>` alias target can split; the policy is the one source of
 * those labels. Nothing is learned from the names themselves.
 */
async function declaredOpenCodeLabels(
  organizationId: string,
): Promise<string[]> {
  if (!config.openappa.enabled) return [];
  const root = await guardrailsPolicyService.get(organizationId);
  return (await openappaDeclarations.aliasTargets(root.content)).flatMap(
    (target) => {
      const id = parseDetectedServerId(target);
      return id?.family === "opencode" ? [id.label] : [];
    },
  );
}

function groupDetectedServers(
  observations: ProxyToolObservation[],
  openCodeLabels: readonly string[],
): DetectedMcpServer[] {
  const servers = new Map<
    string,
    DetectedMcpServer & { toolNames: Set<string> }
  >();
  for (const observation of observations) {
    const family = clientFamilyOf(observation.externalAgentId);
    if (!family) continue;
    const parsed = parseDetectedToolName(
      family,
      observation.toolName,
      openCodeLabels,
    );
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
