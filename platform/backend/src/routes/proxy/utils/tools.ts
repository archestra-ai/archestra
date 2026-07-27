import {
  CLIENT_MCP_TOOL_NAME_PREFIX,
  clientForExternalAgentIds,
  isAgentTool,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import logger from "@/logging";
import { ToolModel, ToolObservationModel } from "@/models";
import type { ToolInvocation, TrustedData } from "@/types";

/**
 * Persist tools if present in the request
 * Skips tools that are already connected to the agent via MCP servers
 * Also skips Archestra built-in tools and agent delegation tools
 *
 * Uses bulk operations to avoid N+1 queries
 */
export const persistTools = async (
  tools: Array<{
    toolName: string;
    toolParameters?: Record<string, unknown>;
    toolDescription?: string;
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

  // Filter out tools that already exist in the database, are Archestra built-in
  // tools, or are agent delegation tools (agent__*). Also deduplicate by tool name
  // to avoid constraint violations.
  //
  // Built-ins are matched with `archestraMcpBranding.isLikelyToolName`, the loose
  // discovery-only recognizer. It recognizes BOTH the default `archestra__` prefix
  // and the org's branded prefix (e.g. `archestra_staging__`), AND the same
  // built-in when a client decorates it with its own label between the server name
  // and the short name (e.g. `archestra_staging__my_mcp_gateway_1234567__run_tool`).
  // A client (including chat routed through this proxy) can hand us a built-in under
  // any of these shapes; matching only the strict prefix would auto-discover the
  // twin, and seeding would later promote it into the catalog as a duplicate
  // built-in.
  const seenToolNames = new Set<string>();
  const toolsToAutoDiscover = tools.filter(({ toolName }) => {
    if (
      existingToolNamesSet.has(toolName) ||
      archestraMcpBranding.isLikelyToolName(toolName) ||
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
      skippedArchestraTools: tools.filter((t) =>
        archestraMcpBranding.isLikelyToolName(t.toolName),
      ).length,
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
    // lose every guardrail. The client namespaces its MCP-server tools with
    // the mcp__ prefix, so those (and everything else) keep the org default,
    // and the override is a visible per-tool policy an admin can tighten.
    const observerClientFamily = clientForExternalAgentIds([
      observer?.externalAgentId,
    ]);
    const nativeClientToolOverride = (toolName: string) =>
      observerClientFamily && !toolName.startsWith(CLIENT_MCP_TOOL_NAME_PREFIX)
        ? {
            action: "allow_when_context_is_untrusted" as const,
            reason: `Native ${observerClientFamily.label} client tool, allowed by default so the client keeps working in sensitive context`,
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
  // the guardrails page can filter observed tools by user and client. Built-in
  // and delegation tools are excluded, matching the discovery filter above.
  // Best-effort: attribution must never fail the proxy request.
  if (observer?.userId) {
    const observableToolNames = tools
      .map(({ toolName }) => toolName)
      .filter(
        (toolName) =>
          !archestraMcpBranding.isLikelyToolName(toolName) &&
          !isAgentTool(toolName),
      );
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
