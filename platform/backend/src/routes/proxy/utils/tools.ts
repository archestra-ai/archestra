import {
  CLIENT_MCP_TOOL_NAME_PREFIX,
  clientForExternalAgentIds,
  isAgentTool,
  isOpenCodeClientAgentId,
  OPENCODE_MCP_TOOL_NAME_PREFIX,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import logger from "@/logging";
import { ToolModel, ToolObservationModel } from "@/models";
import type { ToolInvocation, TrustedData } from "@/types";

/**
 * Persist tools if present in the request
 * Skips tools that are already connected to the agent via MCP servers
 * Also skips tools this platform's gateway served (its built-ins among them)
 * and agent delegation tools
 *
 * Uses bulk operations to avoid N+1 queries
 */
export const persistTools = async (
  tools: Array<{
    toolName: string;
    toolParameters?: Record<string, unknown>;
    toolDescription?: string;
    /**
     * Served by this platform's gateway, as its attestation proves. Left out
     * when the request carries no attestation, in which case built-ins are
     * recognized by name.
     */
    servedByGateway?: boolean;
  }>,
  agentId: string,
  /** Org-configured defaults applied to each newly discovered tool's policies. */
  defaults?: {
    invocationAction?: ToolInvocation.ToolInvocationPolicyAction;
    resultAction?: TrustedData.TrustedDataPolicyAction;
  },
  /**
   * Who is making the request and through which client app, when known.
   * Recorded as tool observations so the guardrails page can filter observed
   * tools by user and client.
   */
  observer?: {
    userId?: string;
    externalAgentId?: string | null;
  },
) => {
  logger.debug(
    { agentId, toolCount: tools.length },
    "[tools] persistTools: starting tool persistence",
  );

  if (tools.length === 0) {
    logger.debug({ agentId }, "[tools] persistTools: no tools to persist");
    return;
  }

  // Get names of tools that already exist in the database (any type: catalog, proxy, etc.)
  const existingToolNames = await ToolModel.getExistingToolNames(
    tools.map((t) => t.toolName),
  );
  const existingToolNamesSet = new Set(existingToolNames);
  logger.debug(
    { agentId, existingToolCount: existingToolNames.length },
    "[tools] persistTools: fetched existing tools globally",
  );

  // Filter out tools that already exist in the database, were served by this
  // platform's gateway, or are agent delegation tools (agent__*). Also
  // deduplicate by tool name to avoid constraint violations.
  //
  // A gateway tool reaches us under whatever name the client gave it, and
  // discovering it under that name would record a twin of a tool we already
  // serve (seeding would later promote a built-in twin into the catalog as a
  // duplicate). When the request's declarations carry attestations,
  // `servedByGateway` says exactly which tools those are, whatever their
  // label, and an unattested lookalike of ours is discovered like any foreign
  // tool, under the org's defaults. Without attestations, built-ins are
  // recognized by `archestraMcpBranding.isLikelyToolName`, the loose
  // discovery-only recognizer: it matches BOTH the default `archestra__` prefix
  // and the org's branded prefix (e.g. `archestra_staging__`), AND the same
  // built-in when a client decorates it with its own label between the server
  // name and the short name (e.g.
  // `archestra_staging__my_mcp_gateway_1234567__run_tool`).
  const seenToolNames = new Set<string>();
  const toolsToAutoDiscover = tools.filter((tool) => {
    const { toolName } = tool;
    if (
      existingToolNamesSet.has(toolName) ||
      isServedByGateway(tool) ||
      isAgentTool(toolName) ||
      seenToolNames.has(toolName)
    ) {
      return false;
    }
    seenToolNames.add(toolName);
    return true;
  });

  logger.debug(
    {
      agentId,
      originalCount: tools.length,
      filteredCount: toolsToAutoDiscover.length,
      skippedExistingTools: tools.filter((t) =>
        existingToolNamesSet.has(t.toolName),
      ).length,
      skippedArchestraTools: tools.filter(isServedByGateway).length,
      skippedAgentTools: tools.filter((t) => isAgentTool(t.toolName)).length,
    },
    "[tools] persistTools: filtered tools for auto-discovery",
  );

  if (toolsToAutoDiscover.length === 0) {
    logger.debug(
      { agentId },
      "[tools] persistTools: no new tools to auto-discover",
    );
  } else {
    // A coding CLI's native tools (Bash, shell, apply_patch, …) default to
    // "Allow always" regardless of the org's discovered-tool call policy: a
    // strict default would block them on the first sensitive tool result and
    // make the CLI unusable — which drives users to disconnect the proxy and
    // lose every guardrail. Claude and Codex namespace their MCP-server tools
    // with `mcp__`; OpenCode uses `mcp:`. Those gateway tools (and everything
    // else) keep the org default, and the override is a visible per-tool policy
    // an admin can tighten.
    const observerClientFamily = clientForExternalAgentIds([
      observer?.externalAgentId,
    ]);
    const isOpenCodeClient = isOpenCodeClientAgentId(observer?.externalAgentId);
    const nativeClientToolOverride = (toolName: string) =>
      (observerClientFamily || isOpenCodeClient) &&
      !(isOpenCodeClient
        ? toolName.startsWith(OPENCODE_MCP_TOOL_NAME_PREFIX)
        : toolName.startsWith(CLIENT_MCP_TOOL_NAME_PREFIX))
        ? {
            action: "allow_when_context_is_untrusted" as const,
            reason: `Native ${observerClientFamily?.label ?? "OpenCode"} client tool, allowed by default so the client keeps working in sensitive context`,
          }
        : undefined;

    // Bulk create tools (single query to check existing + single insert for new)
    logger.debug(
      { agentId, toolCount: toolsToAutoDiscover.length },
      "[tools] persistTools: bulk creating tools",
    );
    await ToolModel.bulkCreateProxyToolsIfNotExists(
      toolsToAutoDiscover.map(
        ({ toolName, toolParameters, toolDescription }) => ({
          name: toolName,
          parameters: toolParameters,
          description: toolDescription,
          invocationDefaultOverride: nativeClientToolOverride(toolName),
        }),
      ),
      agentId,
      defaults,
    );

    logger.debug(
      { agentId, toolCount: toolsToAutoDiscover.length },
      "[tools] persistTools: tool persistence complete",
    );
  }

  // Record who observed the request's tools — new and already-known alike — so
  // the guardrails page can filter observed tools by user and client. Gateway
  // and delegation tools are excluded, matching the discovery filter above.
  // Best-effort: attribution must never fail the proxy request.
  if (observer?.userId) {
    const observableToolNames = tools
      .filter((tool) => !isServedByGateway(tool) && !isAgentTool(tool.toolName))
      .map(({ toolName }) => toolName);
    if (observableToolNames.length > 0) {
      try {
        await ToolObservationModel.recordObservations({
          toolNames: observableToolNames,
          userId: observer.userId,
          externalAgentId: observer.externalAgentId,
        });
      } catch (error) {
        logger.warn(
          { err: error, agentId },
          "[tools] persistTools: failed to record tool observations",
        );
      }
    }
  }
};

// === Internal helpers ===

function isServedByGateway(tool: {
  toolName: string;
  servedByGateway?: boolean;
}): boolean {
  return (
    tool.servedByGateway ?? archestraMcpBranding.isLikelyToolName(tool.toolName)
  );
}
