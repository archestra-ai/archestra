import {
  catalogToolPrefix,
  isBuiltInCatalogId,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  slugifyMcpServerName,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import logger from "@/logging";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import ToolModel, { MCP_TOOL_NAME_MAX_LENGTH } from "@/models/tool";

/**
 * Tool names are `<prefix>__<raw tool name>`, at most 64 characters (the
 * provider function-name limit). A catalog item's prefix is its slugified
 * name until that name leaves one of its tools no room. Then every tool of
 * the item moves to one shorter prefix, cut at a word boundary, with a
 * readable `-2`, `-3` when a different item already carries that cut. An app
 * always gets a prefix of its own, counted the same way, so two apps of one
 * name never share tool names. Items of one slug (a server and its members'
 * personal copies) share their prefix, as their tools share names.
 *
 * Returns the name each raw tool name takes, after allocating (and
 * re-minting the item's stored tools under) a new prefix when needed.
 */
export async function mintCatalogToolNames(params: {
  catalogId: string;
  rawToolNames: readonly string[];
}): Promise<(rawToolName: string) => string> {
  const { prefix } = await ensureCatalogToolPrefix(params);
  return (rawToolName) => ToolModel.slugifyName(prefix, rawToolName);
}

/**
 * After a rename (which clears an allocated prefix): allocate again when the
 * new name leaves a tool no room, and return the tools renamed doing so.
 */
export async function reallocateCatalogToolPrefix(
  catalogId: string,
): Promise<Array<{ oldName: string; newName: string }>> {
  const { renamedTools } = await ensureCatalogToolPrefix({
    catalogId,
    rawToolNames: [],
  });
  return renamedTools;
}

/**
 * Startup: move every catalog item whose tool names were cut and hashed to
 * fit the limit, and every app without a prefix of its own, to its allocated
 * prefix. Idempotent: once an item is allocated it is no longer selected.
 * Returns the items whose tools were renamed, for the policy to recompose.
 */
export async function reconcileCatalogToolPrefixes(): Promise<string[]> {
  const renamedCatalogIds: string[] = [];
  const catalogIds = await ToolModel.findCatalogIdsNeedingToolPrefix({
    minPrefixLength: MIN_TOOL_PREFIX_LENGTH,
  });
  for (const catalogId of catalogIds) {
    if (isBuiltInCatalogId(catalogId)) continue;
    try {
      const { renamedTools } = await ensureCatalogToolPrefix({
        catalogId,
        rawToolNames: [],
      });
      if (renamedTools.length > 0) {
        renamedCatalogIds.push(catalogId);
        logger.info(
          { catalogId, renamed: renamedTools.length },
          "Moved a catalog item's tools to its allocated tool prefix",
        );
      }
    } catch (error) {
      logger.error(
        { catalogId, error },
        "Failed to allocate a catalog item's tool prefix",
      );
    }
  }
  return renamedCatalogIds;
}

// ===========================================================================
// Internal helpers
// ===========================================================================

/**
 * The shortest prefix the allocation cuts a name to: a tool whose raw name
 * leaves less room than this keeps the cut-and-hashed name `slugifyName`
 * gives it, rather than shrinking every other tool's prefix to nothing.
 */
const MIN_TOOL_PREFIX_LENGTH = 12;

type CatalogPrefixInput = Awaited<
  ReturnType<typeof InternalMcpCatalogModel.listToolPrefixInputs>
>[number];

async function ensureCatalogToolPrefix(params: {
  catalogId: string;
  rawToolNames: readonly string[];
}): Promise<{
  prefix: string;
  renamedTools: Array<{ oldName: string; newName: string }>;
}> {
  const catalogs = await InternalMcpCatalogModel.listToolPrefixInputs();
  const catalog = catalogs.find((item) => item.id === params.catalogId);
  if (!catalog) throw new Error(`Catalog item ${params.catalogId} not found`);
  const current = catalogToolPrefix(catalog);
  // The built-in servers' tools carry their branded prefix, whatever their
  // catalog item is called.
  if (isBuiltInCatalogId(catalog.id))
    return { prefix: current, renamedTools: [] };

  const group = prefixSharers(catalog, catalogs);
  const groupIds = new Set(group.map((item) => item.id));
  const storedRawNames = await ToolModel.getRawNamesByCatalogIds([...groupIds]);
  const budget = prefixBudget([...params.rawToolNames, ...storedRawNames]);
  const groupPrefixes = new Set(group.map(catalogToolPrefix));
  const needsAllocation =
    current.length > budget ||
    groupPrefixes.size > 1 ||
    (catalog.serverType === "app" && catalog.toolPrefix === null);
  if (!needsAllocation) return { prefix: current, renamedTools: [] };

  const taken = new Set<string>(archestraMcpBranding.allowedServerNames);
  for (const item of catalogs) {
    if (groupIds.has(item.id)) continue;
    // An app without a prefix of its own yet claims nothing: the startup
    // pass allocates apps oldest first, so the first of two same-named apps
    // keeps the plain name.
    if (item.serverType === "app" && item.toolPrefix === null) continue;
    taken.add(catalogToolPrefix(item));
  }
  // Keep a prefix the group already carries when it still fits and is free,
  // so a new member (a personal copy) joins its group instead of moving it.
  const kept = [...groupPrefixes].find(
    (prefix) =>
      prefix.length <= budget &&
      !taken.has(prefix) &&
      group.some((item) => item.toolPrefix === prefix),
  );
  const prefix =
    kept ??
    allocatePrefix({
      slug: slugifyMcpServerName(catalog.name),
      budget,
      taken,
    });
  const renamedTools = await InternalMcpCatalogModel.applyToolPrefix({
    catalogIds: [...groupIds],
    toolPrefix: prefix,
  });
  return { prefix, renamedTools };
}

/**
 * The items that share a prefix with this one: an app shares with no one;
 * other items share with every non-app item of the same slug.
 */
function prefixSharers(
  catalog: CatalogPrefixInput,
  catalogs: readonly CatalogPrefixInput[],
): CatalogPrefixInput[] {
  if (catalog.serverType === "app") return [catalog];
  const slug = slugifyMcpServerName(catalog.name);
  return catalogs.filter(
    (item) =>
      item.serverType !== "app" && slugifyMcpServerName(item.name) === slug,
  );
}

/**
 * The longest prefix every one of these tools fits under the limit with,
 * ignoring tools whose raw name alone leaves less than the minimum.
 */
function prefixBudget(rawToolNames: readonly string[]): number {
  let budget = MCP_TOOL_NAME_MAX_LENGTH - MCP_SERVER_TOOL_NAME_SEPARATOR.length;
  for (const rawToolName of rawToolNames) {
    const room =
      MCP_TOOL_NAME_MAX_LENGTH -
      MCP_SERVER_TOOL_NAME_SEPARATOR.length -
      slugifyMcpServerName(rawToolName).length;
    if (room >= MIN_TOOL_PREFIX_LENGTH) budget = Math.min(budget, room);
  }
  return budget;
}

/** The slug cut to the budget, then `-2`, `-3`, ... until it is free. */
function allocatePrefix(params: {
  slug: string;
  budget: number;
  taken: ReadonlySet<string>;
}): string {
  const { slug, budget, taken } = params;
  for (let counter = 1; ; counter++) {
    const suffix = counter === 1 ? "" : `-${counter}`;
    const candidate = `${cutAtWordBoundary(slug, budget - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A slug cut to at most `max` characters, at the last `-` or `_` when that
 * keeps at least half of it, without trailing separators.
 */
function cutAtWordBoundary(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const head = slug.slice(0, max + 1);
  const boundary = Math.max(head.lastIndexOf("-"), head.lastIndexOf("_"));
  const cut =
    boundary >= Math.ceil(max / 2)
      ? head.slice(0, boundary)
      : slug.slice(0, max);
  return cut.replace(/[-_]+$/, "") || slug.slice(0, max);
}
