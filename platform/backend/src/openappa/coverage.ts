import {
  ARCHESTRA_MCP_CATALOG_ID,
  calculatePaginationMeta,
  parseFullToolName,
} from "@archestra/shared";
import { parse as parseToml } from "smol-toml";
import { getUnassignedDiscoverableTools } from "@/archestra-mcp-server/dynamic-tools";
import { filterToolNamesByPermission } from "@/archestra-mcp-server/rbac";
import { getAgentTypePermissionChecker } from "@/auth";
import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import ToolModel from "@/models/tool";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import type { BatteryInstallStatus } from "@/types/openappa-batteries";
import type {
  CoverageBatteryFit,
  CoverageEntitiesPage,
  CoverageEntitiesQuery,
  CoverageEntity,
  CoverageKind,
  CoverageRule,
  CoverageRuleCounts,
  CoverageSummary,
  CoverageTool,
  CoverageToolsPage,
  CoverageToolsQuery,
} from "@/types/openappa-coverage";
import { openappaBatteriesService } from "./batteries";

/**
 * Which rule of the policy governs each tool reachable through a visible
 * agent, MCP gateway, or MCP server.
 *
 * The root text and every resolved battery's policy text are parsed here and
 * joined against the stored tool names: a tool matches a rule whose name,
 * without its argument selector, equals the tool's full name, battery rules
 * reaching it through `[server_aliases]`. Selectors, provider-run rules and
 * canonical `mcp/…` spellings in the root are not evaluated, so a named rule
 * is not proof that the runtime judges a given call by it.
 *
 * The whole report is computed per request, then filtered, sorted and paged
 * in memory.
 */
class OpenAppaCoverageService {
  async tools(
    params: { organizationId: string } & CoverageToolsQuery &
      CoverageVisibility,
  ): Promise<CoverageToolsPage> {
    const { tools } = await buildReport(params.organizationId, {
      ...params,
      includeAutoModeTools: params.entityId !== undefined,
      autoModeEntityId: params.entityId,
    });
    const visibleCatalogIds = new Set(params.visibleCatalogIds ?? []);
    const reachable = tools
      .map((row) => row.tool)
      .filter((tool) =>
        params.entityId
          ? tool.agents.some((agent) => agent.id === params.entityId)
          : visibleCatalogIds.has(tool.catalogId),
      );
    const servers = [
      ...new Map(
        reachable.map((tool) => [
          tool.catalogId,
          {
            id: tool.catalogId,
            name: tool.catalogName,
            icon: tool.catalogIcon,
          },
        ]),
      ).values(),
    ].sort(byName);
    const batteries = [
      ...new Set(
        reachable.flatMap((tool) =>
          (!params.catalogId || tool.catalogId === params.catalogId) &&
          tool.rule?.source === "battery" &&
          tool.rule.battery
            ? [tool.rule.battery]
            : [],
        ),
      ),
    ].sort();
    const search = params.search?.toLowerCase();
    const matching = reachable.filter(
      (tool) =>
        (!search ||
          [
            tool.fullName,
            tool.rule?.selector ?? "",
            tool.catalogName,
            tool.prefix,
          ].some((field) => field.toLowerCase().includes(search))) &&
        (!params.catalogId || tool.catalogId === params.catalogId) &&
        (!params.battery || tool.rule?.battery === params.battery) &&
        (!params.governedBy ||
          (params.governedBy === "catchall"
            ? tool.policySource === "fallback"
            : params.governedBy === "built_in"
              ? tool.policySource === "built_in"
              : tool.rule?.source === params.governedBy)) &&
        (!params.kind ||
          tool.kind === params.kind ||
          (params.kind === "write" && tool.kind === "approval")),
    );
    return { ...page(matching, params), servers, batteries };
  }

  async entities(
    params: { organizationId: string } & CoverageEntitiesQuery &
      CoverageVisibility,
  ): Promise<CoverageEntitiesPage> {
    const { tools, entities } = await buildReport(params.organizationId, {
      ...params,
      // Server rows count inventory, not which Auto-mode agents can reach it.
      includeAutoModeTools: params.type !== "mcp_server",
      // Sorting by a count needs every target's Auto-mode tools, not a page's.
      autoModePage:
        params.toolId ||
        params.sortBy === "tools" ||
        params.sortBy === "uncovered"
          ? undefined
          : params,
    });
    const tool = params.toolId
      ? tools.find((row) => row.own && row.tool.toolId === params.toolId)?.tool
      : undefined;
    const reaching = params.toolId
      ? new Set(
          tool ? [tool.catalogId, ...tool.agents.map((agent) => agent.id)] : [],
        )
      : null;
    const search = params.search?.toLowerCase();
    const matching = entities.filter(
      (entity) =>
        isListedTarget(entity) &&
        (!params.entityId || entity.id === params.entityId) &&
        (!search || entity.name.toLowerCase().includes(search)) &&
        (!params.type || entity.type === params.type) &&
        (!reaching || reaching.has(entity.id)),
    );
    matching.sort(compareTargets(params));
    return page(matching, params);
  }

  /** The tools listed by an unfiltered tools request, in aggregate. */
  async summary(
    params: { organizationId: string } & CoverageVisibility,
  ): Promise<CoverageSummary> {
    const { listed, toolsByCatalog, included } = await listedTools(params);
    const fitting = await openappaBatteriesService.batteriesForCatalogs({
      organizationId: params.organizationId,
      catalogIds: [...toolsByCatalog.keys()],
    });

    const broken = included
      .filter(
        (
          battery,
        ): battery is typeof battery & {
          status: Exclude<BatteryInstallStatus, "active">;
        } => battery.status !== "active",
      )
      .map((battery) => ({
        name: battery.name,
        status: battery.status,
        tools: listed.filter(
          (tool) => tool.rule?.battery === battery.name && !tool.enforced,
        ).length,
      }));

    const active = included
      .filter((battery) => battery.status === "active")
      .map((battery) => ({
        name: battery.name,
        tools: listed.filter(
          (tool) => tool.rule?.battery === battery.name && tool.enforced,
        ).length,
      }));

    const available = new Map<
      string,
      CoverageSummary["batteries"]["available"][number]
    >();
    for (const [catalogId, serverTools] of toolsByCatalog) {
      const battery = fitting.get(catalogId);
      if (battery?.status !== "available") continue;
      const tools = wouldGovern(battery.policy, serverTools);
      if (tools === 0) continue;
      const entry = available.get(battery.battery) ?? {
        name: battery.battery,
        servers: [],
        tools: 0,
      };
      entry.servers.push(serverTools[0]?.catalogName ?? "");
      entry.tools += tools;
      available.set(battery.battery, entry);
    }

    const byTools = (a: { name: string; tools: number }, b: typeof a) =>
      b.tools - a.tools || a.name.localeCompare(b.name);
    return {
      totals: { tools: listed.length, ...countRules(listed) },
      batteries: {
        active: active.sort(byTools),
        broken: broken.sort(byTools),
        available: [...available.values()].sort(byTools),
      },
    };
  }

  /**
   * The batteries not declared yet that fit the visible registry servers, or
   * the one server `catalogId` names, with the rules each would bring. A
   * server with a declared battery, or none that fits, is left out.
   */
  async batteryFits(
    params: { organizationId: string; catalogId?: string } & CoverageVisibility,
  ): Promise<CoverageBatteryFit[]> {
    const { toolsByCatalog } = await listedTools(params);
    const catalogIds = [...toolsByCatalog.keys()].filter(
      (id) => !params.catalogId || id === params.catalogId,
    );
    const batteries = await openappaBatteriesService.batteriesForCatalogs({
      organizationId: params.organizationId,
      catalogIds,
    });
    const fits: CoverageBatteryFit[] = [];
    for (const catalogId of catalogIds) {
      const battery = batteries.get(catalogId);
      const serverTools = toolsByCatalog.get(catalogId) ?? [];
      if (battery?.status !== "available") continue;
      fits.push({
        mcpServerId: catalogId,
        mcpServerName: serverTools[0]?.catalogName ?? "",
        toolPrefixes: [...new Set(serverTools.map((tool) => tool.prefix))],
        battery: battery.battery,
        description: battery.description,
        evidence: battery.evidence,
        include: battery.include,
        namespaces: battery.namespaces,
        credentials: battery.credentials,
        newlyCovered: wouldGovern(battery.policy, serverTools),
        rules: batteryRules(battery.policy, serverTools),
      });
    }
    return fits.sort(
      (a, b) =>
        b.newlyCovered - a.newlyCovered ||
        a.mcpServerName.localeCompare(b.mcpServerName),
    );
  }
}

export const openappaCoverageService = new OpenAppaCoverageService();

/**
 * What a user sees of the coverage report: the registry entries they can
 * reach and the agent types they may read.
 */
export async function coverageVisibility(
  userId: string,
  organizationId: string,
) {
  // Registry administration is `update` on every entry, the grant the
  // retired `mcpServerInstallation:admin` role action converted into.
  const [checker, isCatalogAdmin] = await Promise.all([
    getAgentTypePermissionChecker({ userId, organizationId }),
    isMcpInstallationAdmin({ userId, organizationId }),
  ]);
  const visibleCatalogIds = await InternalMcpCatalogModel.findAccessibleIds({
    userId,
    isAdmin: isCatalogAdmin,
    organizationId,
  });
  return {
    userId,
    visibleCatalogIds,
    agentTypes: checker
      .getAgentTypesWithPermission("read")
      .filter(
        (type): type is "agent" | "mcp_gateway" =>
          type === "agent" || type === "mcp_gateway",
      ),
    excludeOtherPersonalTypes: (["agent", "mcp_gateway"] as const).filter(
      (type) => checker.isAdmin(type),
    ),
  };
}

/**
 * The tools an unfiltered tools request lists, by registry server: every
 * tool once, judged without a selector.
 */
async function listedTools(
  params: { organizationId: string } & CoverageVisibility,
) {
  const { tools, included } = await buildReport(params.organizationId, {
    ...params,
    includeAutoModeTools: false,
  });
  const visibleCatalogIds = new Set(params.visibleCatalogIds ?? []);
  const listed = tools
    .filter((row) => row.own && visibleCatalogIds.has(row.tool.catalogId))
    .map((row) => row.tool);
  const toolsByCatalog = new Map<string, CoverageTool[]>();
  for (const tool of listed)
    toolsByCatalog.set(tool.catalogId, [
      ...(toolsByCatalog.get(tool.catalogId) ?? []),
      tool,
    ]);
  return { listed, toolsByCatalog, included };
}

/**
 * The tools no rule names that a battery's policy would, once installed on
 * their server: an install binds every namespace the battery declares to the
 * server, so a rule `mcp/<namespace>/<tool>` names the server's `<tool>`.
 */
function wouldGovern(policy: string, tools: CoverageTool[]): number {
  const named = new Set(
    toolEntries(policy).flatMap((entry) => {
      const spelled = splitSelector(entry.name);
      const canonical =
        spelled.selector === null && CANONICAL_RULE_NAME.exec(spelled.base);
      return canonical ? [canonical[2]] : [];
    }),
  );
  return tools.filter((tool) => !tool.rule && named.has(tool.name)).length;
}

/**
 * Every rule of a battery's policy that names one of the server's tools once
 * installed on it, read as the tools table reads it.
 */
function batteryRules(
  policy: string,
  tools: CoverageTool[],
): CoverageBatteryFit["rules"] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return toolEntries(policy).flatMap((entry) => {
    const spelled = splitSelector(entry.name);
    const canonical = CANONICAL_RULE_NAME.exec(spelled.base);
    const tool = canonical && byName.get(canonical[2]);
    if (!tool) return [];
    const { rule, kind } = candidate({
      entry,
      spelled,
      match: tool.fullName,
      source: {
        source: "battery",
        battery: null,
        batteryEntry: null,
        batteryStatus: null,
        line: null,
      },
      enforced: false,
    });
    return [
      {
        tool: tool.fullName,
        selector: rule.selector,
        kind,
        delta: rule.delta,
        requires: rule.requires,
        annotator: rule.annotator,
        currentRule: tool.rule?.source ?? null,
      },
    ];
  });
}

function ruleBucket(tool: CoverageTool): keyof CoverageRuleCounts {
  if (!tool.rule)
    return tool.policySource === "built_in" ? "builtInFallback" : "catchAll";
  return tool.enforced ? tool.rule.source : "notEnforced";
}

function countRules(tools: CoverageTool[]): CoverageRuleCounts {
  const counts = emptyRuleCounts();
  for (const tool of tools) counts[ruleBucket(tool)] += 1;
  return counts;
}

function emptyRuleCounts(): CoverageRuleCounts {
  return {
    root: 0,
    battery: 0,
    notEnforced: 0,
    catchAll: 0,
    builtInFallback: 0,
  };
}

// =============================================================================
// The report
// =============================================================================

type Report = {
  /** Every table row, sorted; `own` marks the row a tool is judged by without a selector. */
  tools: Array<{ tool: CoverageTool; own: boolean }>;
  entities: CoverageEntity[];
  /** The batteries the policy includes, `refused` while its composition fails. */
  included: Array<{ name: string; status: BatteryInstallStatus }>;
};

type CoverageVisibility = {
  userId?: string;
  agentTypes?: Array<"agent" | "mcp_gateway">;
  excludeOtherPersonalTypes?: Array<"agent" | "mcp_gateway">;
  /** Registry entries this caller can see directly. */
  visibleCatalogIds?: string[];
  /** Resolve the current viewer's dynamic Auto-mode tool access. */
  includeAutoModeTools?: boolean;
  /** Only resolve Auto-mode access for rows returned by an entities page. */
  autoModePage?: CoverageEntitiesQuery;
  /** Only resolve Auto-mode access for the target whose tools are requested. */
  autoModeEntityId?: string;
};

/** A rule as it applies to one full tool name, battery rules once per alias target. */
type Candidate = {
  rule: CoverageRule;
  /** The full tool name the rule matches. */
  match: string;
  kind: Exclude<CoverageKind, "unlisted">;
};

async function buildReport(
  organizationId: string,
  visibility?: CoverageVisibility,
): Promise<Report> {
  const [snapshot, inventory] = await Promise.all([
    openappaBatteriesService.coverageSnapshot(organizationId),
    ToolModel.findCoverageInventory(
      organizationId,
      visibility?.userId
        ? {
            userId: visibility.userId,
            agentTypes: visibility.agentTypes ?? ["agent", "mcp_gateway"],
            excludeOtherPersonalTypes:
              visibility.excludeOtherPersonalTypes ?? [],
          }
        : undefined,
    ),
  ]);
  const { resolution, rootContent } = snapshot;
  const refused = snapshot.lastError !== null;
  const statusOf = new Map<string, BatteryInstallStatus>(
    snapshot.batteries.map((battery) => [
      battery.name,
      refused ? "refused" : battery.status,
    ]),
  );

  // Root rules in text order, then every battery's in include order.
  const candidates: Candidate[] = [];
  const headerLines = toolHeaderLines(rootContent);
  const rootEntries = toolEntries(rootContent);
  const rootLines =
    headerLines.length === rootEntries.length ? headerLines : [];
  const fallbackLine = refused
    ? null
    : rootEntries.reduce<number | null>(
        (line, entry, index) =>
          entry.name === "*" ? (rootLines[index] ?? null) : line,
        null,
      );
  rootEntries.forEach((entry, index) => {
    const spelled = splitSelector(entry.name);
    if (spelled.base === "*") return;
    candidates.push(
      candidate({
        entry,
        spelled,
        match: spelled.base,
        source: {
          source: "root",
          battery: null,
          batteryEntry: null,
          batteryStatus: null,
          line: rootLines[index] ?? null,
        },
        enforced: !refused,
      }),
    );
  });
  const targets = new Map(
    resolution.aliases.map((alias) => [alias.namespace, alias.servers]),
  );
  for (const included of resolution.entries) {
    if (!included.battery) continue;
    const status = statusOf.get(included.name) ?? "unavailable";
    const batteryEntries = toolEntries(included.battery.policy);
    const batteryHeaderLines = toolHeaderLines(included.battery.policy);
    for (const [index, entry] of batteryEntries.entries()) {
      const spelled = splitSelector(entry.name);
      const canonical = CANONICAL_RULE_NAME.exec(spelled.base);
      if (!canonical) continue;
      const [, namespace, toolName] = canonical;
      for (const prefix of targets.get(namespace) ?? [])
        candidates.push(
          candidate({
            entry,
            spelled,
            match: `${prefix}__${toolName}`,
            source: {
              source: "battery",
              battery: included.name,
              batteryEntry: included.entry,
              batteryStatus: status,
              line:
                batteryHeaderLines.length === batteryEntries.length
                  ? (batteryHeaderLines[index] ?? null)
                  : null,
            },
            enforced: !refused && status === "active",
          }),
        );
    }
  }
  const byMatch = new Map<string, Candidate[]>();
  for (const entry of candidates)
    byMatch.set(entry.match, [...(byMatch.get(entry.match) ?? []), entry]);

  const agentsByTool = new Map<string, Map<string, string>>();
  const inCoverage = new Set(inventory.tools.map((tool) => tool.id));
  const autoAccess = new Map<string, Set<string>>();
  const autoModeEntityIds =
    visibility?.includeAutoModeTools && visibility.autoModePage
      ? autoModePageEntityIds(inventory, visibility, visibility.autoModePage)
      : visibility?.autoModeEntityId
        ? new Set([visibility.autoModeEntityId])
        : null;
  if (visibility?.includeAutoModeTools && visibility.userId) {
    await Promise.all(
      inventory.entities
        .filter(
          (entity) =>
            entity.accessAllTools &&
            (!autoModeEntityIds || autoModeEntityIds.has(entity.id)),
        )
        .map(async (entity) => {
          const { tools: assigned, exclusionSets } =
            await agentToolExclusionsService.getFilteredMcpToolsByAgent(
              entity.id,
            );
          const discovered = await getUnassignedDiscoverableTools({
            assignedToolNames: new Set(assigned.map((tool) => tool.name)),
            agentId: entity.id,
            userId: visibility.userId,
            organizationId,
            exclusionSets,
          });
          const permittedNames = await filterToolNamesByPermission(
            [...assigned, ...discovered].map((tool) => tool.name),
            visibility.userId,
            organizationId,
          );
          // Search resolves each name once: assigned rows win, then the
          // newest discoverable row. Count that same dispatchable set.
          const seenNames = new Set<string>();
          const reachableIds = [...assigned, ...discovered].flatMap((tool) => {
            if (!permittedNames.has(tool.name)) return [];
            if (seenNames.has(tool.name)) return [];
            seenNames.add(tool.name);
            return inCoverage.has(tool.id) ? [tool.id] : [];
          });
          autoAccess.set(entity.id, new Set(reachableIds));
        }),
    );
  }
  for (const { toolId, agentId, agentName } of inventory.assignments) {
    const effective = autoAccess.get(agentId);
    if (effective && !effective.has(toolId)) continue;
    agentsByTool.set(
      toolId,
      (agentsByTool.get(toolId) ?? new Map()).set(agentId, agentName),
    );
  }
  for (const entity of inventory.entities) {
    const effective = autoAccess.get(entity.id);
    if (!effective) continue;
    for (const toolId of effective)
      agentsByTool.set(
        toolId,
        (agentsByTool.get(toolId) ?? new Map()).set(entity.id, entity.name),
      );
  }
  const catalogById = new Map(
    inventory.catalogs.map((catalog) => [catalog.id, catalog]),
  );

  // One row per tool judged without a selector, one more per selector rule.
  const rows: Report["tools"] = [];
  const toolsByCatalog = new Map<string, CoverageTool[]>();
  for (const tool of inventory.tools) {
    const { serverName: prefix, toolName } = parseFullToolName(tool.name);
    if (prefix === null) continue;
    const agents = [...(agentsByTool.get(tool.id) ?? new Map())]
      .map(([id, name]) => ({ id, name }))
      .sort(byName);
    const matched = byMatch.get(tool.name) ?? [];
    const base = {
      toolId: tool.id,
      catalogId: tool.catalogId,
      catalogName: catalogById.get(tool.catalogId)?.name ?? "",
      catalogIcon: catalogById.get(tool.catalogId)?.icon ?? null,
      prefix,
      name: toolName,
      fullName: tool.name,
      readOnly: tool.readOnlyHint,
      agents,
    };
    const primary = matched.find((entry) => entry.rule.selector === null);
    const own: CoverageTool = primary
      ? {
          ...base,
          kind: primary.kind,
          policySource: primary.rule.source,
          rule: primary.rule,
          fallbackLine: null,
          unlisted: false,
          enforced: primary.rule.enforced,
        }
      : {
          ...base,
          kind: "unlisted",
          policySource: snapshot.rootRevision === 0 ? "built_in" : "fallback",
          rule: null,
          fallbackLine,
          unlisted: true,
          enforced: false,
        };
    rows.push({ tool: own, own: true });
    for (const entry of matched)
      if (entry.rule.selector !== null)
        rows.push({
          tool: {
            ...base,
            kind: entry.kind,
            policySource: entry.rule.source,
            rule: entry.rule,
            fallbackLine: null,
            unlisted: false,
            enforced: entry.rule.enforced,
          },
          own: false,
        });
    const listed = toolsByCatalog.get(tool.catalogId) ?? [];
    listed.push(own);
    toolsByCatalog.set(tool.catalogId, listed);
  }
  rows.sort(
    (a, b) =>
      toolRank(a.tool) - toolRank(b.tool) ||
      a.tool.fullName.localeCompare(b.tool.fullName),
  );
  const explicitlyGovernedTools = new Set(
    rows.filter((row) => row.tool.enforced).map((row) => row.tool.toolId),
  );

  const entitiesById = new Map<string, CoverageEntity>(
    inventory.entities.map((entity) => [
      entity.id,
      {
        id: entity.id,
        name: entity.name,
        type: entity.agentType,
        scope: entity.scope,
        icon: entity.icon,
        toolCount: 0,
        governedCount: 0,
        fallbackCount: 0,
        builtInCount: 0,
        rules: emptyRuleCounts(),
        autoMode: entity.accessAllTools,
      },
    ]),
  );
  for (const { tool, own } of rows) {
    if (!own) continue;
    for (const agent of tool.agents) {
      const entity = entitiesById.get(agent.id);
      if (!entity) continue;
      entity.toolCount += 1;
      if (explicitlyGovernedTools.has(tool.toolId)) entity.governedCount += 1;
      if (tool.unlisted) entity.fallbackCount += 1;
      if (tool.catalogId === ARCHESTRA_MCP_CATALOG_ID) entity.builtInCount += 1;
      entity.rules[ruleBucket(tool)] += 1;
      entitiesById.set(agent.id, entity);
    }
  }
  const visibleCatalogIds = new Set(visibility?.visibleCatalogIds ?? []);
  for (const catalog of inventory.catalogs) {
    if (
      catalog.id === ARCHESTRA_MCP_CATALOG_ID ||
      !visibleCatalogIds.has(catalog.id)
    )
      continue;
    const serverTools = toolsByCatalog.get(catalog.id) ?? [];
    entitiesById.set(catalog.id, {
      id: catalog.id,
      name: catalog.name,
      type: "mcp_server",
      scope: catalog.scope,
      icon: catalog.icon,
      toolCount: serverTools.length,
      governedCount: serverTools.filter((tool) =>
        explicitlyGovernedTools.has(tool.toolId),
      ).length,
      fallbackCount: serverTools.filter((tool) => tool.unlisted).length,
      builtInCount: 0,
      rules: countRules(serverTools),
      autoMode: false,
    });
  }
  const entities = [...entitiesById.values()];

  return {
    tools: rows,
    entities,
    included: [...statusOf].map(([name, status]) => ({ name, status })),
  };
}

/** Agents are not policy targets; only gateways and registry servers are listed. */
function isListedTarget(entity: { type: string }): boolean {
  return entity.type !== "agent";
}

/** Compute the visible page before resolving each Auto-mode agent's tool access. */
function autoModePageEntityIds(
  inventory: Awaited<ReturnType<typeof ToolModel.findCoverageInventory>>,
  visibility: CoverageVisibility,
  autoModePage: CoverageEntitiesQuery,
): Set<string> {
  const visibleCatalogIds = new Set(visibility.visibleCatalogIds ?? []);
  const candidates = [
    ...inventory.entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.agentType,
    })),
    ...inventory.catalogs
      .filter(
        (catalog) =>
          catalog.id !== ARCHESTRA_MCP_CATALOG_ID &&
          visibleCatalogIds.has(catalog.id),
      )
      .map((catalog) => ({
        id: catalog.id,
        name: catalog.name,
        type: "mcp_server" as const,
      })),
  ];
  const matching = candidates
    .filter(
      (entity) =>
        isListedTarget(entity) &&
        (!autoModePage.entityId || entity.id === autoModePage.entityId) &&
        (!autoModePage.type || entity.type === autoModePage.type) &&
        (!autoModePage.search ||
          entity.name
            .toLowerCase()
            .includes(autoModePage.search.toLowerCase())),
    )
    .sort(compareTargets(autoModePage));
  return new Set(page(matching, autoModePage).data.map((entity) => entity.id));
}

const TARGET_TYPE_ORDER: Record<CoverageEntity["type"], number> = {
  mcp_server: 0,
  mcp_gateway: 1,
  agent: 2,
};

/** A target as far as sorting reads it; a page is sorted before its counts exist. */
type SortableTarget = Pick<CoverageEntity, "id" | "name" | "type"> &
  Partial<Pick<CoverageEntity, "toolCount" | "governedCount">>;

/** How an entities query orders its targets; see `sortBy`. */
function compareTargets(
  query: Pick<CoverageEntitiesQuery, "sortBy" | "sortDirection">,
): (a: SortableTarget, b: SortableTarget) => number {
  const sortBy = query.sortBy ?? "name";
  const direction =
    query.sortDirection ?? (sortBy === "uncovered" ? "desc" : "asc");
  const sign = direction === "desc" ? -1 : 1;
  const alphabetical = (a: SortableTarget, b: SortableTarget) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (sortBy === "name") return (a, b) => sign * alphabetical(a, b);
  const key = (target: SortableTarget) =>
    sortBy === "type"
      ? TARGET_TYPE_ORDER[target.type]
      : sortBy === "tools"
        ? (target.toolCount ?? 0)
        : (target.toolCount ?? 0) - (target.governedCount ?? 0);
  return (a, b) => sign * (key(a) - key(b)) || alphabetical(a, b);
}

// =============================================================================
// Parsing
// =============================================================================

/** One `[[policy.tool]]` entry, as far as coverage reads it. */
type ToolEntry = {
  name: string;
  delta: unknown;
  requires: unknown;
  annotator: unknown;
};

/** Every `[[policy.tool]]` entry with a string name, in text order. */
function toolEntries(text: string): ToolEntry[] {
  let document: Record<string, unknown>;
  try {
    document = parseToml(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const policy = asRecord(document.policy);
  const tools = Array.isArray(policy?.tool) ? policy.tool : [];
  return tools.flatMap((tool) => {
    const entry = asRecord(tool);
    return entry && typeof entry.name === "string"
      ? [
          {
            name: entry.name,
            delta: entry.delta,
            requires: entry.requires,
            annotator: entry.annotator,
          },
        ]
      : [];
  });
}

/**
 * The 1-based line of every `[[policy.tool]]` header. The parser keeps no
 * positions, so the n-th header is the n-th entry's line whenever every entry
 * is written as a header.
 */
function toolHeaderLines(text: string): number[] {
  return text
    .split("\n")
    .flatMap((line, index) => (TOOL_HEADER.test(line) ? [index + 1] : []));
}

function splitSelector(name: string): {
  base: string;
  selector: string | null;
} {
  const open = name.indexOf("(");
  if (open === -1) return { base: name, selector: null };
  const close = name.endsWith(")") ? name.length - 1 : name.length;
  return { base: name.slice(0, open), selector: name.slice(open + 1, close) };
}

function candidate(params: {
  entry: ToolEntry;
  spelled: { base: string; selector: string | null };
  match: string;
  source: Pick<
    CoverageRule,
    "source" | "battery" | "batteryEntry" | "batteryStatus" | "line"
  >;
  enforced: boolean;
}): Candidate {
  const { entry, spelled, match, source, enforced } = params;
  const delta = asRecord(entry.delta) ?? {};
  const requires = asRecord(entry.requires) ?? {};
  const rule: CoverageRule = {
    ...source,
    name: spelled.base,
    selector: spelled.selector,
    delta: {
      ...(typeof delta.trust === "string" ? { trust: delta.trust } : {}),
      ...optionalList("audience", audience(delta.audience)),
    },
    requires: {
      ...(typeof requires.trust === "string" ? { trust: requires.trust } : {}),
      ...optionalList("audience", audience(requires.audience)),
      ...optionalList("attention", strings(requires.attention)),
    },
    annotator: typeof entry.annotator === "string" ? entry.annotator : null,
    enforced,
  };
  const attention = rule.requires.attention ?? [];
  const requiresAnything = Object.entries(requires).some(
    ([key, value]) =>
      !(key === "attention" && Array.isArray(value) && value.length === 0),
  );
  let kind: Candidate["kind"];
  if (attention.length > 0) kind = "approval";
  else if (requiresAnything) kind = "write";
  else if (rule.annotator !== null || rule.delta.trust || rule.delta.audience)
    kind = "read";
  else kind = "neutral";
  return { rule, match, kind };
}

/** An audience as a list, or an object whose `contains` list names it. */
function audience(value: unknown): string[] | null {
  if (Array.isArray(value)) return strings(value);
  return strings(asRecord(value)?.contains);
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : null;
}

function optionalList<K extends string>(
  key: K,
  value: string[] | null,
): Partial<Record<K, string[]>> {
  return value === null ? {} : ({ [key]: value } as Record<K, string[]>);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// =============================================================================
// Ordering and paging
// =============================================================================

/** Unlisted first, then not enforced, then enforced. */
function toolRank(tool: CoverageTool): number {
  if (tool.unlisted) return 0;
  return tool.enforced ? 2 : 1;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

function page<T>(
  items: T[],
  params: { limit: number; offset: number },
): { data: T[]; pagination: ReturnType<typeof calculatePaginationMeta> } {
  return {
    data: items.slice(params.offset, params.offset + params.limit),
    pagination: calculatePaginationMeta(items.length, params),
  };
}

/** A battery rule's name: `mcp/<namespace>/<tool>`. */
const CANONICAL_RULE_NAME = /^mcp\/([^/]+)\/(.+)$/;

const TOOL_HEADER = /^\s*\[\[\s*policy\s*\.\s*tool\s*\]\]/;
