// Pure formatting for the OAuth clients table's "Access" column: resolve the
// allowed-resource IDs stored on a client against the agents the viewer can
// see, and turn them into a readable summary instead of raw counts.

const MAX_NAMES = 3;

export type AccessSummary = {
  primary: string;
  secondary: string | null;
};

type NamedAgent = {
  id: string;
  name: string;
  agentType: string;
};

export function summarizeMcpClientAccess(params: {
  grantType: "client_credentials" | "authorization_code";
  allowedGatewayIds: string[];
  agents: NamedAgent[];
}): AccessSummary {
  const { grantType, allowedGatewayIds, agents } = params;
  const resolved = resolveAgents(allowedGatewayIds, agents);

  if (grantType === "authorization_code") {
    return {
      primary: "Each signed-in user's access",
      secondary:
        allowedGatewayIds.length > 0
          ? `+ grant: ${formatNames(resolved, allowedGatewayIds.length)}`
          : null,
    };
  }

  const gatewayCount = resolved.filter(
    (agent) => agent.agentType === "mcp_gateway",
  ).length;
  const agentCount = resolved.filter(
    (agent) => agent.agentType === "agent",
  ).length;
  const unresolvedCount = allowedGatewayIds.length - resolved.length;

  const parts: string[] = [];
  if (gatewayCount > 0) {
    parts.push(pluralize(gatewayCount, "MCP gateway", "MCP gateways"));
  }
  if (agentCount > 0) {
    parts.push(pluralize(agentCount, "agent", "agents"));
  }
  if (unresolvedCount > 0) {
    parts.push(pluralize(unresolvedCount, "other", "others"));
  }
  if (parts.length === 0) {
    parts.push("No resources");
  }

  return {
    primary: parts.join(" · "),
    secondary:
      resolved.length > 0
        ? formatNames(resolved, allowedGatewayIds.length)
        : null,
  };
}

export function summarizeLlmClientAccess(params: {
  grantType: "client_credentials" | "authorization_code";
  allowedLlmProxyIds: string[];
  proxies: NamedAgent[];
  providerKeySummary: string | null;
}): AccessSummary {
  const { grantType, allowedLlmProxyIds, proxies, providerKeySummary } = params;
  const resolved = resolveAgents(allowedLlmProxyIds, proxies);

  if (grantType === "authorization_code") {
    return {
      primary: "Each signed-in user's access",
      secondary:
        allowedLlmProxyIds.length > 0
          ? `+ grant: ${formatNames(resolved, allowedLlmProxyIds.length)}`
          : null,
    };
  }

  const secondaryParts: string[] = [];
  if (resolved.length > 0) {
    secondaryParts.push(formatNames(resolved, allowedLlmProxyIds.length));
  }
  if (providerKeySummary) {
    secondaryParts.push(`keys: ${providerKeySummary}`);
  }

  return {
    primary:
      allowedLlmProxyIds.length > 0
        ? pluralize(allowedLlmProxyIds.length, "LLM proxy", "LLM proxies")
        : "No resources",
    secondary: secondaryParts.length > 0 ? secondaryParts.join(" · ") : null,
  };
}

// ===
// Internal helpers
// ===

function resolveAgents(ids: string[], agents: NamedAgent[]): NamedAgent[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return ids.flatMap((id) => {
    const agent = byId.get(id);
    return agent ? [agent] : [];
  });
}

/**
 * Up to MAX_NAMES resolved names, then "+N more" covering everything not
 * shown — including IDs that didn't resolve because the viewer can't see
 * those resources. When nothing resolved at all, falls back to a plain count.
 */
function formatNames(resolved: NamedAgent[], totalCount: number): string {
  if (resolved.length === 0) {
    return pluralize(totalCount, "resource", "resources");
  }
  const shown = resolved.slice(0, MAX_NAMES);
  const hiddenCount = totalCount - shown.length;
  const names = shown.map((agent) => agent.name).join(", ");
  return hiddenCount > 0 ? `${names} +${hiddenCount} more` : names;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
