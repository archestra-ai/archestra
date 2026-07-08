import {
  ARCHESTRA_MCP_CATALOG_ID,
  isAgentTool,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  AgentExcludedToolModel,
  AgentModel,
  InternalMcpCatalogModel,
  ToolModel,
} from "@/models";
import { type AgentToolExclusions, ApiError, type Tool } from "@/types";

/**
 * Per-agent tool exclusions for Auto-tool mode ("access all tools").
 *
 * Manages the excluded-tools junction table: write-time validation, atomic
 * full replace, chat MCP client cache eviction after commit, and the read
 * shape enforcement callers consume. Exclusions only take effect while the
 * agent's `accessAllTools` setting is on; they persist (inert) when it is off.
 */

/**
 * Exclusion sets shaped for enforcement callers. `toolIds` matches tool rows
 * by id; `toolKeys` (`"<catalogId>:<name>"`) matches by dispatch identity for
 * callers that resolve tools by name rather than row (gateway dispatch,
 * Archestra built-ins); `resourceUris` are the MCP App `ui://` resource URIs
 * declared by the excluded tools' meta, for filtering resource listings whose
 * catalog stays reachable through a non-excluded sibling tool.
 */
export type AgentToolExclusionSets = {
  toolIds: ReadonlySet<string>;
  toolKeys: ReadonlySet<string>;
  resourceUris: ReadonlySet<string>;
};

const EMPTY_EXCLUSION_SETS: AgentToolExclusionSets = {
  toolIds: new Set(),
  toolKeys: new Set(),
  resourceUris: new Set(),
};

export function hasAnyExclusions(sets: AgentToolExclusionSets): boolean {
  return sets.toolIds.size > 0;
}

/** Whether a concrete tool row is excluded (by its own id). */
export function isToolRowExcluded(
  tool: { id: string },
  sets: AgentToolExclusionSets,
): boolean {
  return sets.toolIds.has(tool.id);
}

/**
 * Whether a tool resolved by dispatch identity (catalog + name) is excluded.
 * Used where the caller has no row id (gateway/mcp-client assignment shapes,
 * Archestra built-in dispatch).
 */
export function isToolIdentityExcluded(
  tool: { catalogId: string | null; name: string },
  sets: AgentToolExclusionSets,
): boolean {
  if (tool.catalogId == null) {
    return false;
  }
  return sets.toolKeys.has(toolKey(tool.catalogId, tool.name));
}

class AgentToolExclusionsService {
  /** Current exclusions in API shape (GET /api/agents/:id/tool-exclusions). */
  async getExclusions(agentId: string): Promise<AgentToolExclusions> {
    const excludedToolIds =
      await AgentExcludedToolModel.findToolIdsByAgent(agentId);
    return { excludedToolIds };
  }

  /**
   * Validate and atomically replace the excluded-tools set, then evict the
   * cached chat MCP client strictly AFTER the transaction commits (never on
   * failure) so a live chat refreshes its tool list.
   */
  async replaceExclusions(params: {
    agentId: string;
    organizationId: string;
    excludedToolIds: string[];
  }): Promise<AgentToolExclusions> {
    const { agentId, organizationId } = params;
    const excludedToolIds = [...new Set(params.excludedToolIds)];

    await this.validateToolIds(excludedToolIds, organizationId);

    try {
      await withDbTransaction(async (tx) => {
        // Serialize concurrent replaces for the same agent: without the row
        // lock, two delete+insert replaces under read committed can interleave
        // into a merged union of both requested states.
        await AgentModel.lockRowForUpdate(agentId, tx);
        await AgentExcludedToolModel.replaceForAgent(
          agentId,
          excludedToolIds,
          tx,
        );
      });
    } catch (error) {
      // TOCTOU: a tool deleted between validation and insert surfaces as an FK
      // violation — map it to a client error instead of a 500.
      if (isForeignKeyViolation(error)) {
        throw new ApiError(400, "One or more excluded tools no longer exist");
      }
      throw error;
    }

    // Evict AFTER commit only: an eviction on failure would drop a valid cache
    // for unchanged exclusions. Dynamic import breaks the module cycle
    // (chat-mcp-client → archestra-mcp-server → dynamic-tools → this service).
    const { clearChatMcpClient } = await import("@/clients/chat-mcp-client");
    clearChatMcpClient(agentId);

    logger.info(
      { agentId, excludedToolCount: excludedToolIds.length },
      "Replaced agent tool exclusions",
    );

    return { excludedToolIds };
  }

  /**
   * Add tool ids to the agent's excluded-tools set (a union, leaving existing
   * exclusions in place), then evict the cached chat MCP client after commit.
   * The current set is re-read INSIDE the same row lock the full replace takes,
   * so concurrent adds/replaces for one agent can't lose each other's writes.
   * Used to "remove" a tool from an Auto-tool ("access all tools") agent, where
   * deleting an assignment row would be a no-op.
   */
  async addExclusions(params: {
    agentId: string;
    organizationId: string;
    toolIds: string[];
  }): Promise<AgentToolExclusions> {
    const { agentId, organizationId } = params;
    const toAdd = [...new Set(params.toolIds)];

    await this.validateToolIds(toAdd, organizationId);

    let excludedToolIds: string[] = [];
    try {
      await withDbTransaction(async (tx) => {
        await AgentModel.lockRowForUpdate(agentId, tx);
        const current = await AgentExcludedToolModel.findToolIdsByAgent(
          agentId,
          tx,
        );
        excludedToolIds = [...new Set([...current, ...toAdd])];
        await AgentExcludedToolModel.replaceForAgent(
          agentId,
          excludedToolIds,
          tx,
        );
      });
    } catch (error) {
      // TOCTOU: a tool deleted between validation and insert surfaces as an FK
      // violation — map it to a client error instead of a 500.
      if (isForeignKeyViolation(error)) {
        throw new ApiError(400, "One or more excluded tools no longer exist");
      }
      throw error;
    }

    const { clearChatMcpClient } = await import("@/clients/chat-mcp-client");
    clearChatMcpClient(agentId);

    logger.info(
      {
        agentId,
        addedCount: toAdd.length,
        excludedToolCount: excludedToolIds.length,
      },
      "Added agent tool exclusions",
    );

    return { excludedToolIds };
  }

  /**
   * The agent's exclusion sets for enforcement callers. Does NOT check the
   * agent's accessAllTools setting — use when the caller has already
   * established Auto-tool mode (e.g. via dynamicAccessContext).
   */
  async getExclusionSets(agentId: string): Promise<AgentToolExclusionSets> {
    const toolRows =
      await AgentExcludedToolModel.findExcludedToolRowsByAgent(agentId);
    if (toolRows.length === 0) {
      return EMPTY_EXCLUSION_SETS;
    }
    return {
      toolIds: new Set(toolRows.map((row) => row.toolId)),
      toolKeys: new Set(
        toolRows
          .filter((row) => row.catalogId != null)
          .map((row) => toolKey(row.catalogId as string, row.name)),
      ),
      resourceUris: new Set(
        toolRows
          .map((row) => toolUiResourceUri(row.meta))
          .filter((uri): uri is string => uri != null),
      ),
    };
  }

  /**
   * Exclusion sets gated on the agent's accessAllTools setting: empty (no-op)
   * when Auto-tool mode is off, so callers get zero behavior change for
   * Custom-mode agents.
   */
  async getActiveExclusionSets(
    agentId: string,
  ): Promise<AgentToolExclusionSets> {
    const accessAllTools = await AgentModel.getAccessAllTools(agentId);
    if (!accessAllTools) {
      return EMPTY_EXCLUSION_SETS;
    }
    return this.getExclusionSets(agentId);
  }

  /**
   * The agent's assigned MCP tools with excluded rows removed, plus the
   * exclusion sets used to filter them. The single chokepoint every dispatch
   * surface (gateway tools/list, search_tools, run_tool, resource client
   * resolution, chat UI hints) shares, so the fetch-then-filter pairing lives in
   * one place and a future enforcement change lands everywhere at once. Callers
   * that already loaded the sets pass them in to skip the re-query; the two
   * queries run in parallel otherwise.
   */
  async getFilteredMcpToolsByAgent(
    agentId: string,
    preloadedExclusionSets?: AgentToolExclusionSets,
  ): Promise<{ tools: Tool[]; exclusionSets: AgentToolExclusionSets }> {
    const [rows, exclusionSets] = await Promise.all([
      ToolModel.getMcpToolsByAgent(agentId),
      preloadedExclusionSets ?? this.getActiveExclusionSets(agentId),
    ]);
    return {
      tools: rows.filter((tool) => !isToolRowExcluded(tool, exclusionSets)),
      exclusionSets,
    };
  }

  // === Private validation helpers ===

  private async validateToolIds(
    toolIds: string[],
    organizationId: string,
  ): Promise<void> {
    if (toolIds.length === 0) {
      return;
    }
    const tools = await ToolModel.getByIds(toolIds);
    const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
    const catalogIds = [
      ...new Set(
        tools
          .map((tool) => tool.catalogId)
          .filter((id): id is string => id != null),
      ),
    ];
    const catalogs = await InternalMcpCatalogModel.getByIds(catalogIds);

    for (const toolId of toolIds) {
      const tool = toolsById.get(toolId);
      if (!tool) {
        throw new ApiError(400, `Unknown tool id: ${toolId}`);
      }
      // Delegation tools are outside the exclusion model entirely: manage
      // sub-agent access through delegation assignment instead.
      if (
        tool.delegateToAgentId != null ||
        isAgentTool(tool.name) ||
        tool.name.startsWith("agent__")
      ) {
        throw new ApiError(
          400,
          `Delegation tools cannot be excluded: ${tool.name}`,
        );
      }
      // Only catalog-backed MCP tools participate in the Auto-tool surface.
      if (tool.catalogId == null) {
        throw new ApiError(400, `Tool is not excludable: ${tool.name}`);
      }
      if (tool.catalogId === ARCHESTRA_MCP_CATALOG_ID) {
        const shortName =
          archestraMcpBranding.getToolShortName(tool.name) ?? tool.name;
        if (
          shortName === TOOL_SEARCH_TOOLS_SHORT_NAME ||
          shortName === TOOL_RUN_TOOL_SHORT_NAME
        ) {
          throw new ApiError(
            400,
            `The ${shortName} meta tool cannot be excluded`,
          );
        }
      } else {
        const catalog = catalogs.get(tool.catalogId);
        // Cross-org tools are reported as unknown to avoid leaking existence.
        if (
          !catalog ||
          (catalog.organizationId != null &&
            catalog.organizationId !== organizationId)
        ) {
          throw new ApiError(400, `Unknown tool id: ${toolId}`);
        }
      }
    }
  }
}

export const agentToolExclusionsService = new AgentToolExclusionsService();

// === Internal helpers ===

/**
 * Dispatch-identity key for an exclusion match. Archestra built-in rows are
 * keyed by SHORT name, not the stored row name: on a white-labeled deployment
 * the row carries a branded prefix (`acme__list_agents`), but dispatch reaches
 * the same tool by its short name (`run_tool`) or the default alias
 * (`archestra__list_agents`) too. Normalizing both the build side
 * (getExclusionSets) and every check side (isToolIdentityExcluded) through this
 * one helper keeps the branded row, the branded call, and the default-alias
 * call all matching the same key. Third-party rows are keyed by name verbatim
 * (their names carry no branding alias).
 */
function toolKey(catalogId: string, name: string): string {
  const identityName =
    catalogId === ARCHESTRA_MCP_CATALOG_ID
      ? (archestraMcpBranding.getToolShortName(name) ?? name)
      : name;
  return `${catalogId}:${identityName}`;
}

/**
 * MCP App `ui://` resource URI declared by a tool's meta. Checks the canonical
 * path (`_meta.ui.resourceUri`) and the deprecated flat key
 * (`_meta."ui/resourceUri"`), mirroring findToolsByUiResourceUri.
 */
function toolUiResourceUri(
  meta: Record<string, unknown> | null,
): string | null {
  const innerMeta = (
    meta as {
      _meta?: { ui?: { resourceUri?: unknown }; "ui/resourceUri"?: unknown };
    } | null
  )?._meta;
  const canonical = innerMeta?.ui?.resourceUri;
  if (typeof canonical === "string" && canonical.length > 0) {
    return canonical;
  }
  const legacy = innerMeta?.["ui/resourceUri"];
  return typeof legacy === "string" && legacy.length > 0 ? legacy : null;
}

// Only the excluded-tools FK constraint signals the validate/insert race this
// service maps to a 400; any other FK failure (e.g. agent_id) is unexpected and
// must keep surfacing as a 500. Matched by prefix so a truncated Postgres
// identifier still matches, and because the `agent_id` FK (which must stay 500)
// does not share this prefix.
const RACE_FK_CONSTRAINT_PREFIXES = ["agent_excluded_tools_tool_id_"];

/** Excluded-tool foreign-key violation (23503), possibly wrapped in a cause chain. */
function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current != null && typeof current === "object") {
    const { code, constraint } = current as {
      code?: unknown;
      constraint?: unknown;
    };
    if (
      code === "23503" &&
      typeof constraint === "string" &&
      RACE_FK_CONSTRAINT_PREFIXES.some((prefix) =>
        constraint.startsWith(prefix),
      )
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
