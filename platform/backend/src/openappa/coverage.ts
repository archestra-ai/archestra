import {
  ARCHESTRA_MCP_CATALOG_ID,
  calculatePaginationMeta,
  parseFullToolName,
} from "@archestra/shared";
import { parse as parseToml } from "smol-toml";
import { getUnassignedDiscoverableTools } from "@/archestra-mcp-server/dynamic-tools";
import { filterToolNamesByPermission } from "@/archestra-mcp-server/rbac";
import ToolModel from "@/models/tool";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import type { BatteryInstallStatus } from "@/types/openappa-batteries";
import type {
  CoverageEntitiesPage,
  CoverageEntitiesQuery,
  CoverageEntity,
  CoverageKind,
  CoverageRule,
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
    return page(
      entities.filter(
        (entity) =>
          (!params.entityId || entity.id === params.entityId) &&
          (!search || entity.name.toLowerCase().includes(search)) &&
          (!params.type || entity.type === params.type) &&
          (!reaching || reaching.has(entity.id)),
      ),
      params,
    );
  }
}

export const openappaCoverageService = new OpenAppaCoverageService();

// =============================================================================
// The report
// =============================================================================

type Report = {
  /** Every table row, sorted; `own` marks the row a tool is judged by without a selector. */
  tools: Array<{ tool: CoverageTool; own: boolean }>;
  entities: CoverageEntity[];
};

type CoverageVisibility = {
  userId?: string;
  agentTypes?: Array<"agent" | "mcp_gateway">;
  excludeOtherPersonalTypes?: Array<"agent" | "mcp_gateway">;
  /** Registry entries this caller can see directly. */
  visibleCatalogIds?: string[];
  /** Resolve the current viewer's dynamic Auto-mode tool access. */
  includeAutoModeTools?: boolean;
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
  if (visibility?.includeAutoModeTools && visibility.userId) {
    await Promise.all(
      inventory.entities
        .filter((entity) => entity.accessAllTools)
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
      autoMode: false,
    });
  }
  const entities = [...entitiesById.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );

  return { tools: rows, entities };
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
