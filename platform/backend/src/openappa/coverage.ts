import { calculatePaginationMeta, parseFullToolName } from "@archestra/shared";
import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import ToolModel from "@/models/tool";
import { UNDECLARED_TOOL_ANNOTATOR } from "@/services/guardrails-policy";
import type { CompositionView } from "@/types/openappa-batteries";
import type {
  CoverageBatteryFit,
  CoverageBatteryStatus,
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
import {
  type DeployedFile,
  deployedFiles,
  deployedSource,
  effectiveToolRules,
} from "./battery-target";
import { enforcedBattery } from "./composition-view";
import {
  asRecord,
  type ToolEntry,
  toolEntries,
  toolHeaderLines,
} from "./policy-text";

/**
 * Which rule of the policy governs each tool of a visible MCP server.
 *
 * The root text and every resolved battery's policy text are parsed here and
 * joined against the stored tool names: a tool matches a rule whose name,
 * without its argument selector, equals the tool's full name, battery rules
 * reaching it through `aliases.mcp`. Selectors, provider-run rules and
 * canonical `mcp/…` spellings in the root are not evaluated, so a named rule
 * is not proof that the runtime judges a given call by it.
 *
 * Server pages sorted by metadata select their catalog page before the tools
 * and policy counts are hydrated.
 */
class OpenAppaCoverageService {
  /** Complete policy rows for one caller-readable catalog, without list facets. */
  async toolsForCatalog(
    params: { organizationId: string; catalogId: string } & CoverageVisibility,
  ): Promise<CoverageTool[]> {
    if (!params.visibleCatalogIds?.includes(params.catalogId)) return [];
    const { tools } = await buildReport(
      params.organizationId,
      {
        ...params,
        visibleCatalogIds: [params.catalogId],
        includeAppCatalogs: true,
      },
      params.catalogId,
    );
    return tools
      .map((row) => row.tool)
      .filter((tool) => tool.catalogId === params.catalogId);
  }

  async tools(
    params: { organizationId: string } & CoverageToolsQuery &
      CoverageVisibility,
  ): Promise<CoverageToolsPage> {
    const { tools } = await buildReport(params.organizationId, params);
    const visibleCatalogIds = new Set(params.visibleCatalogIds ?? []);
    const reachable = tools
      .map((row) => row.tool)
      .filter((tool) => visibleCatalogIds.has(tool.catalogId));
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
        (!params.governedBy || tool.policySource === params.governedBy) &&
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
    // Server names and types do not depend on policy or tool assignments.
    // Choose that page first, then classify only its catalogs' tools.
    if (!params.toolId && params.sortBy !== "tools") {
      const catalogs = await ToolModel.findCoverageCatalogs({
        organizationId: params.organizationId,
        catalogIds: params.visibleCatalogIds ?? [],
      });
      const search = params.search?.toLowerCase();
      const candidates = catalogs
        .map((catalog) => ({ ...catalog, type: "mcp_server" as const }))
        .filter(
          (catalog) =>
            (!params.entityId || catalog.id === params.entityId) &&
            (!params.type || catalog.type === params.type) &&
            (!search || catalog.name.toLowerCase().includes(search)),
        )
        .sort(compareTargets(params));
      const selected = page(candidates, params);
      if (selected.data.length === 0)
        return { data: [], pagination: selected.pagination };
      const { entities } = await buildReport(params.organizationId, {
        ...params,
        inventoryCatalogIds: selected.data.map((catalog) => catalog.id),
      });
      const byId = new Map(entities.map((entity) => [entity.id, entity]));
      return {
        data: selected.data.flatMap((catalog) => {
          const entity = byId.get(catalog.id);
          return entity ? [entity] : [];
        }),
        pagination: selected.pagination,
      };
    }
    const { tools, entities } = await buildReport(params.organizationId, {
      ...params,
      inventoryCatalogIds: params.visibleCatalogIds ?? [],
    });
    const toolCatalogId = params.toolId
      ? (tools.find((row) => row.own && row.tool.toolId === params.toolId)?.tool
          .catalogId ?? null)
      : undefined;
    const search = params.search?.toLowerCase();
    const matching = entities.filter(
      (entity) =>
        (!params.entityId || entity.id === params.entityId) &&
        (!search || entity.name.toLowerCase().includes(search)) &&
        (!params.type || entity.type === params.type) &&
        (toolCatalogId === undefined || entity.id === toolCatalogId),
    );
    matching.sort(compareTargets(params));
    return page(matching, params);
  }

  /** The tools listed by an unfiltered tools request, in aggregate. */
  async summary(
    params: { organizationId: string } & CoverageVisibility,
  ): Promise<CoverageSummary> {
    const { listed, toolsByCatalog, included, composition, rootRevision } =
      await listedTools(params);
    const fitting = await openappaBatteriesService.batteriesForCatalogs({
      organizationId: params.organizationId,
      catalogIds: [...toolsByCatalog.keys()],
    });

    const broken = included
      .filter(
        (
          battery,
        ): battery is typeof battery & {
          status: Exclude<CoverageBatteryStatus, "active">;
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
      const tools = wouldGovern(battery.files, serverTools);
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
    const { served, refusal } = composition;
    return {
      totals: { tools: listed.length, ...countRules(listed) },
      batteries: {
        active: active.sort(byTools),
        broken: broken.sort(byTools),
        available: [...available.values()].sort(byTools),
      },
      composition: {
        kind: served.kind,
        servedRootRevision:
          served.kind === "root_only" ? null : served.rootRevision,
        refusedRootRevision: refusal?.rootRevision ?? null,
        // The rows follow the current text. An earlier composition of
        // another revision, or of an unknown one, may hold other rules.
        rulesMayDiffer:
          served.kind === "previous" &&
          (served.rootRevision === null ||
            served.rootRevision !== rootRevision),
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
        benefit: battery.benefit,
        setup: battery.setup,
        newlyCovered: wouldGovern(battery.files, serverTools),
        rules: batteryRules(battery.files, serverTools),
      });
    }
    return fits.sort(
      (a, b) =>
        b.newlyCovered - a.newlyCovered ||
        a.mcpServerName.localeCompare(b.mcpServerName),
    );
  }

  /**
   * The rule the organization's current policy applies to each full tool
   * name, with the rule's own TOML: the first specific rule that names it,
   * else the catch-all. Null for a tool no rule reaches. A selector rule
   * (`name(selector)`) depends on the call's arguments, so it is not picked.
   */
  async rulesForTools(params: {
    organizationId: string;
    toolNames: string[];
  }): Promise<Map<string, { rule: CoverageRule; text: string | null } | null>> {
    const rules = new Map<
      string,
      { rule: CoverageRule; text: string | null } | null
    >();
    if (params.toolNames.length === 0) return rules;
    const snapshot = await openappaBatteriesService.coverageSnapshot(
      params.organizationId,
    );
    const { fallback, byMatch, rootContent, viewed } = matchRules(snapshot);
    for (const toolName of new Set(params.toolNames)) {
      const matched =
        byMatch.get(toolName)?.find((entry) => entry.rule.selector === null) ??
        fallback;
      if (!matched) {
        rules.set(toolName, null);
        continue;
      }
      const deployed = matched.rule.batteryEntry
        ? viewed.get(matched.rule.batteryEntry)
        : undefined;
      const source =
        matched.rule.source === "battery"
          ? deployed
            ? deployedSource(deployed)
            : null
          : rootContent;
      rules.set(toolName, {
        rule: matched.rule,
        text:
          source !== null && matched.rule.line !== null
            ? ruleExcerpt(source, matched.rule.line)
            : null,
      });
    }
    return rules;
  }
}

export const openappaCoverageService = new OpenAppaCoverageService();

/** What a user sees of the coverage report: the registry entries they can reach. */
export async function coverageVisibility(
  userId: string,
  organizationId: string,
) {
  // Registry administration is `update` on every entry, the grant the
  // retired `mcpServerInstallation:admin` role action converted into.
  const isCatalogAdmin = await isMcpInstallationAdmin({
    userId,
    organizationId,
  });
  const visibleCatalogIds = await InternalMcpCatalogModel.findAccessibleIds({
    userId,
    isAdmin: isCatalogAdmin,
    organizationId,
  });
  return { visibleCatalogIds };
}

/**
 * The tools an unfiltered tools request lists, by registry server: every
 * tool once, judged without a selector.
 */
async function listedTools(
  params: { organizationId: string } & CoverageVisibility,
) {
  const { tools, included, composition, rootRevision } = await buildReport(
    params.organizationId,
    {
      ...params,
      inventoryCatalogIds: params.visibleCatalogIds ?? [],
    },
  );
  const visibleCatalogIds = new Set(params.visibleCatalogIds ?? []);
  const listed = tools
    .filter((row) => row.own && visibleCatalogIds.has(row.tool.catalogId))
    .map((row) => row.tool);
  const toolsByCatalog = new Map<string, CoverageTool[]>();
  for (const tool of listed) {
    const catalogTools = toolsByCatalog.get(tool.catalogId);
    if (catalogTools) catalogTools.push(tool);
    else toolsByCatalog.set(tool.catalogId, [tool]);
  }
  return { listed, toolsByCatalog, included, composition, rootRevision };
}

/**
 * The uncovered tools a battery's policy would govern once installed on
 * their server: an install binds every namespace the battery declares to the
 * server, so a rule `mcp/<namespace>/<tool>` names the server's `<tool>`.
 */
function wouldGovern(files: DeployedFile[], tools: CoverageTool[]): number {
  const named = new Set(
    effectiveToolRules(files).flatMap(({ entry }) => {
      const spelled = splitSelector(entry.name);
      const canonical =
        spelled.selector === null && CANONICAL_RULE_NAME.exec(spelled.base);
      return canonical ? [canonical[2]] : [];
    }),
  );
  return tools.filter(
    (tool) => tool.policySource === "not_covered" && named.has(tool.name),
  ).length;
}

/**
 * Every rule of a battery's policy that names one of the server's tools once
 * installed on it, read as the tools table reads it.
 */
function batteryRules(
  files: DeployedFile[],
  tools: CoverageTool[],
): CoverageBatteryFit["rules"] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return effectiveToolRules(files).flatMap(({ entry }) => {
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
        currentRule:
          tool.policySource === "not_covered"
            ? null
            : (tool.rule?.source ?? null),
      },
    ];
  });
}

function ruleBucket(tool: CoverageTool): keyof CoverageRuleCounts {
  if (tool.policySource === "not_covered" || !tool.rule) return "notCovered";
  if (!tool.enforced) return "notEnforced";
  return tool.rule.source === "catchall" ? "catchAll" : tool.rule.source;
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
    notCovered: 0,
  };
}

// =============================================================================
// The report
// =============================================================================

type Report = {
  /** Every table row, sorted; `own` marks the row a tool is judged by without a selector. */
  tools: Array<{ tool: CoverageTool; own: boolean }>;
  entities: CoverageEntity[];
  /**
   * The batteries the policy includes, as the enforced composition holds
   * them: `refused` when only the root text is served, `pending` when an
   * earlier composition is enforced that did not hold them.
   */
  included: Array<{ name: string; status: CoverageBatteryStatus }>;
  composition: CompositionView;
  /** The current root revision the rows were classified against. */
  rootRevision: number;
};

type CoverageVisibility = {
  /** Registry entries this caller can see directly. */
  visibleCatalogIds?: string[];
  /** Per-catalog inspection reads app catalogs too; the overview leaves them out. */
  includeAppCatalogs?: boolean;
  /** Visible catalogs, narrowed to the selected page when counts do not sort it. */
  inventoryCatalogIds?: string[];
};

/**
 * Every tool rule the policy composes, indexed by the full tool name it
 * matches, plus the catch-all a tool no rule names falls to. Root rules come
 * first in text order, then each battery's in include order, as the runtime
 * reads them.
 */
function matchRules(snapshot: CoverageSnapshot) {
  const { resolution, rootContent, viewed } = snapshot;
  const { composition } = snapshot;
  // Nothing is enforced only when the root text alone is served. A refusal
  // that keeps an earlier composition keeps its rules enforced, with the
  // statuses that composition was composed with.
  const refused = composition.served.kind === "root_only";
  const enforcedOf = new Map(
    snapshot.batteries.map((battery) => [
      battery.name,
      enforcedBattery(composition, battery),
    ]),
  );
  const statusOf = new Map<string, CoverageBatteryStatus>(
    [...enforcedOf].map(([name, enforced]) => [name, enforced.status]),
  );

  // Root rules in text order, then every battery's in include order.
  const candidates: Candidate[] = [];
  const headerLines = toolHeaderLines(rootContent);
  const rootEntries = toolEntries(rootContent);
  const rootLines =
    headerLines.length === rootEntries.length ? headerLines : [];
  const fallbackIndex = rootEntries.findIndex((entry) => entry.name === "*");
  const fallbackEntry = rootEntries[fallbackIndex];
  const fallbackLine = refused ? null : (rootLines[fallbackIndex] ?? null);
  const fallback =
    !refused && fallbackEntry
      ? candidate({
          entry: fallbackEntry,
          spelled: splitSelector(fallbackEntry.name),
          match: "*",
          source: {
            source: "catchall",
            battery: null,
            batteryEntry: null,
            batteryStatus: null,
            line: fallbackLine,
          },
          enforced: true,
        })
      : null;
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
  // A base waiting only on its target's credentials composes, and so enforces.
  const composed = new Set(
    [...enforcedOf].flatMap(([name, enforced]) =>
      enforced.composed ? [name] : [],
    ),
  );
  for (const included of resolution.entries) {
    if (!included.battery) continue;
    const status = statusOf.get(included.name) ?? "unavailable";
    const deployed = viewed.get(included.entry);
    if (!deployed) continue;
    for (const { entry, line } of effectiveToolRules(deployedFiles(deployed))) {
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
              line,
            },
            enforced: !refused && composed.has(included.name),
          }),
        );
    }
  }
  const byMatch = new Map<string, Candidate[]>();
  for (const entry of candidates) {
    const matches = byMatch.get(entry.match);
    if (matches) matches.push(entry);
    else byMatch.set(entry.match, [entry]);
  }

  return { statusOf, fallbackLine, fallback, byMatch, rootContent, viewed };
}

type CoverageSnapshot = Awaited<
  ReturnType<typeof openappaBatteriesService.coverageSnapshot>
>;

/**
 * The TOML block that starts at 1-based `line`: its header and every line up
 * to the next table header, without the comments and blank lines that lead
 * into that next header.
 */
function ruleExcerpt(text: string, line: number): string | null {
  const lines = text.split("\n");
  if (line < 1 || line > lines.length) return null;
  const block = [lines[line - 1]];
  for (let index = line; index < lines.length; index++) {
    if (/^\s*\[/.test(lines[index])) break;
    block.push(lines[index]);
  }
  // Comments and blank lines at the end introduce the next block.
  while (block.length > 1 && /^\s*(#.*)?$/.test(block[block.length - 1]))
    block.pop();
  return block.join("\n");
}

/** A rule as it applies to one full tool name, battery rules once per alias target. */
type Candidate = {
  rule: CoverageRule;
  /** The full tool name the rule matches. */
  match: string;
  kind: Exclude<CoverageKind, "unlisted">;
};

/**
 * `catalogId` reads only that catalog's tools. Each tool's row depends on its
 * own catalog and the policy alone, so the rows for that catalog are the same
 * as an organization-wide report's.
 */
async function buildReport(
  organizationId: string,
  visibility?: CoverageVisibility,
  catalogId?: string,
): Promise<Report> {
  const [snapshot, inventory] = await Promise.all([
    openappaBatteriesService.coverageSnapshot(organizationId),
    ToolModel.findCoverageInventory(organizationId, {
      includeAppCatalogs: visibility?.includeAppCatalogs,
      catalogIds: visibility?.inventoryCatalogIds,
      catalogId,
    }),
  ]);
  const { composition } = snapshot;
  const { statusOf, fallbackLine, fallback, byMatch } = matchRules(snapshot);

  const catalogById = new Map(
    inventory.catalogs.map((catalog) => [catalog.id, catalog]),
  );

  // One row per tool judged without a selector, one more per selector rule.
  const rows: Report["tools"] = [];
  const toolsByCatalog = new Map<string, CoverageTool[]>();
  for (const tool of inventory.tools) {
    const { serverName: prefix, toolName } = parseFullToolName(tool.name);
    if (prefix === null) continue;
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
    };
    const specific = matched.find((entry) => entry.rule.selector === null);
    const primary = specific ?? fallback;
    // The default wildcards deliberately add no coverage: noop adds nothing,
    // and the default model catch-all is what judges a tool no rule names.
    // Origin and revision do not change this classification.
    const covered =
      primary !== null &&
      primary !== undefined &&
      !(
        primary.rule.source === "catchall" &&
        primary.rule.annotator !== null &&
        DEFAULT_CATCH_ALL_ANNOTATORS.has(primary.rule.annotator)
      );
    const own: CoverageTool = primary
      ? {
          ...base,
          kind: covered ? primary.kind : "unlisted",
          policySource: covered ? primary.rule.source : "not_covered",
          rule: primary.rule,
          fallbackLine: specific ? null : fallbackLine,
          unlisted: !covered,
          enforced: primary.rule.enforced,
        }
      : {
          ...base,
          kind: "unlisted",
          policySource: "not_covered",
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
    rows
      .filter(
        (row) => row.tool.enforced && row.tool.policySource !== "not_covered",
      )
      .map((row) => row.tool.toolId),
  );

  const entities: CoverageEntity[] = [];
  const visibleCatalogIds = new Set(visibility?.visibleCatalogIds ?? []);
  for (const catalog of inventory.catalogs) {
    if (!visibleCatalogIds.has(catalog.id)) continue;
    const serverTools = toolsByCatalog.get(catalog.id) ?? [];
    entities.push({
      id: catalog.id,
      name: catalog.name,
      type: "mcp_server",
      scope: catalog.scope,
      icon: catalog.icon,
      toolCount: serverTools.length,
      governedCount: serverTools.filter((tool) =>
        explicitlyGovernedTools.has(tool.toolId),
      ).length,
      fallbackCount: serverTools.filter(
        (tool) => tool.rule === null || tool.rule.source === "catchall",
      ).length,
      rules: countRules(serverTools),
    });
  }

  return {
    tools: rows,
    entities,
    included: [...statusOf].map(([name, status]) => ({ name, status })),
    composition,
    rootRevision: snapshot.rootRevision,
  };
}

/** A target as far as sorting reads it; a page is sorted before its counts exist. */
type SortableTarget = Pick<CoverageEntity, "id" | "name"> &
  Partial<Pick<CoverageEntity, "toolCount">>;

/** How an entities query orders its targets; see `sortBy`. */
function compareTargets(
  query: Pick<CoverageEntitiesQuery, "sortBy" | "sortDirection">,
): (a: SortableTarget, b: SortableTarget) => number {
  const sortBy = query.sortBy ?? "name";
  const sign = query.sortDirection === "desc" ? -1 : 1;
  const alphabetical = (a: SortableTarget, b: SortableTarget) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (sortBy === "name") return (a, b) => sign * alphabetical(a, b);
  return (a, b) =>
    sign * ((a.toolCount ?? 0) - (b.toolCount ?? 0)) || alphabetical(a, b);
}

// =============================================================================
// Parsing
// =============================================================================

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
  const forwards = asRecord(entry.forwards) ?? {};
  const requires = asRecord(entry.requires) ?? {};
  const rule: CoverageRule = {
    ...source,
    name: spelled.base,
    selector: spelled.selector,
    delta: {
      ...(typeof delta.trust === "string" ? { trust: delta.trust } : {}),
      ...optionalList("audience", audience(delta.audience)),
    },
    forwards: {
      ...(typeof forwards.trust === "string" ? { trust: forwards.trust } : {}),
      ...optionalList("audience", audience(forwards.audience)),
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
  // `audience.within` is ignored by the runtime, so it requires nothing.
  const requiresAnything = Object.entries(requires).some(([key, value]) => {
    if (key === "attention") return !Array.isArray(value) || value.length > 0;
    if (key === "audience") return (audience(value)?.length ?? 0) > 0;
    return true;
  });
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

/** The catch-all annotators a default policy routes `*` to. */
const DEFAULT_CATCH_ALL_ANNOTATORS = new Set([
  "noop",
  // The catch-all's name in starting policies saved before the rename.
  "archestra.undeclared-tool",
  UNDECLARED_TOOL_ANNOTATOR,
]);
