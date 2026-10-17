import {
  RESOURCE_ACCESS_RELATIONS,
  type ResourceAccessRelation,
} from "@archestra/shared";
import { readResourceAccessParams } from "@/components/resource-access-params";
import { PAGE_SIZE_OPTIONS } from "@/components/ui/table-pagination";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { parseLabelsParam } from "@/lib/labels-param";
import type {
  McpRegistryListQuery,
  McpRegistryPageParams,
} from "@/lib/mcp/mcp-registry.query";
import {
  attentionCatalogIds,
  facetIssues,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import {
  INSTALLED_STATUS_VALUE,
  NOT_INSTALLED_STATUS_VALUE,
  type SortKey,
  selectedAttentionFacet,
} from "./registry-list-params";

/**
 * The registry list's order as URL params. The page's own `sortBy` /
 * `sortDirection` carry the API's values, so a link is the request.
 */
const SORT_PARAMS: Record<
  SortKey,
  {
    sortBy: NonNullable<McpRegistryListQuery["sortBy"]>;
    sortDirection: "asc" | "desc";
  }
> = {
  attention: { sortBy: "attention", sortDirection: "asc" },
  "name-asc": { sortBy: "name", sortDirection: "asc" },
  "name-desc": { sortBy: "name", sortDirection: "desc" },
  newest: { sortBy: "createdAt", sortDirection: "desc" },
  oldest: { sortBy: "createdAt", sortDirection: "asc" },
  "most-tools": { sortBy: "toolCount", sortDirection: "desc" },
  "issue-age": { sortBy: "issueAge", sortDirection: "asc" },
};

export function sortParamsForKey(key: SortKey) {
  return SORT_PARAMS[key];
}

/** The sort menu entry a URL names; "Action required" when it names none. */
export function sortKeyFromParams(params: {
  get(name: string): string | null;
}): SortKey {
  const sortBy = params.get("sortBy");
  const sortDirection = params.get("sortDirection");
  const match = (
    Object.entries(SORT_PARAMS) as [SortKey, (typeof SORT_PARAMS)[SortKey]][]
  ).find(
    ([, value]) =>
      value.sortBy === sortBy &&
      (value.sortDirection === sortDirection ||
        // Orders with a single direction accept either spelling.
        value.sortBy === "attention" ||
        value.sortBy === "issueAge"),
  );
  return match?.[0] ?? "attention";
}

/** The longest search term the registry list API accepts. */
export const MAX_REGISTRY_SEARCH_LENGTH = 256;

/**
 * What the request for this URL depends on that loads separately: names that
 * map to ids through the environments list, author names that map through the
 * issue index, the issue-age ranking (from the index), and catalog ids that
 * come from the issue rule (which also needs the live deployment feed). A
 * request built before those arrive asks for the wrong rows. The default
 * attention order needs none of them: the server ranks it.
 */
export function registryQueryInputs(params: {
  get(name: string): string | null;
  getAll(name: string): string[];
}): {
  needsEnvironments: boolean;
  needsIssueIndex: boolean;
  needsIssues: boolean;
} {
  const needsIssues =
    params.getAll("issue").length > 0 ||
    selectedAttentionFacet(new Set(params.getAll("status"))) !== null;
  return {
    needsEnvironments: params.getAll("environment").length > 0,
    needsIssueIndex:
      needsIssues ||
      params.getAll("author").length > 0 ||
      sortKeyFromParams(params) === "issue-age",
    needsIssues,
  };
}

/** Whether two rank-tier lists name the same items in the same tiers. */
export function sameRankTiers(
  a: ReadonlyArray<ReadonlyArray<string>>,
  b: ReadonlyArray<ReadonlyArray<string>>,
): boolean {
  const key = (tiers: ReadonlyArray<ReadonlyArray<string>>) =>
    JSON.stringify(
      tiers.filter((tier) => tier.length > 0).map((tier) => [...tier].sort()),
    );
  return key(a) === key(b);
}

/** The page (0-based) and page size a registry URL asks for. */
export function registryPageFromParams(params: {
  get(name: string): string | null;
}): { pageIndex: number; pageSize: number } {
  // Hand-edited or stale links must not produce a request the API refuses.
  const pageIndex = Math.max(
    0,
    Math.floor(Number(params.get("page") || "1") || 1) - 1,
  );
  const requestedPageSize = Number(params.get("pageSize"));
  const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize)
    ? requestedPageSize
    : DEFAULT_TABLE_LIMIT;
  return { pageIndex, pageSize };
}

/**
 * The page request a registry URL makes, built from the URL alone, so it can
 * be sent before the page renders; null when the request maps names or issues
 * through data that loads separately (see {@link registryQueryInputs}).
 * Equal to the page's own request for the same URL, so the page finds it in
 * the cache.
 */
export function registryPageRequestFromUrl(params: {
  get(name: string): string | null;
  getAll(name: string): string[];
}): McpRegistryPageParams | null {
  const { needsEnvironments, needsIssueIndex } = registryQueryInputs(params);
  if (needsEnvironments || needsIssueIndex) return null;
  const { pageIndex, pageSize } = registryPageFromParams(params);
  const access = readResourceAccessParams(params);
  return {
    ...buildRegistryListQuery({
      searchParams: params,
      access: {
        access: access.access,
        sharedWith: access.sharedWith,
        owner: access.owner,
      },
      environments: [],
      authors: [],
      issuesByCatalog: new Map(),
    }),
    limit: pageSize,
    offset: pageIndex * pageSize,
  };
}

/**
 * The list query without its order. Selections and "every matching row" are
 * about which rows match, so a live re-rank must not reset them.
 */
export function withoutOrder(
  query: McpRegistryListQuery,
): McpRegistryListQuery {
  const {
    sortBy: _sortBy,
    sortDirection: _direction,
    rankTiers: _tiers,
    ...rest
  } = query;
  return rest;
}

/**
 * The paged list request for the registry page's URL. The URL keeps the form
 * links have always had — environment and author by name, the Status and
 * facet values — and this maps them to the ids the API filters on:
 *
 * - an environment name stands for every environment with that name;
 * - an author name stands for every author whose display name it is, so two
 *   people sharing a name both still match, as they did when the list
 *   filtered names in the browser;
 * - the attention facets and the Issue filter become the catalog ids the
 *   browser's issue rule puts in them (it holds the live deployment feed);
 * - the issue-age order sends that rule's ranking as tiers; the attention
 *   order is ranked by the server, unless the browser's live rule disagrees.
 */
export function buildRegistryListQuery({
  searchParams,
  access,
  environments,
  authors,
  issuesByCatalog,
  attentionTiers,
}: {
  searchParams: {
    get(name: string): string | null;
    getAll(name: string): string[];
  };
  access: {
    access?: ResourceAccessRelation[];
    sharedWith?: string[];
    owner?: string[];
  };
  environments: ReadonlyArray<{ id: string; name: string }>;
  /** Every visible catalog item's author, from the issue index. */
  authors: ReadonlyArray<RegistryAuthor>;
  issuesByCatalog: Map<string, McpServerIssue[]>;
  /**
   * The attention order's tiers from the browser's live issue rule. Sent only
   * when the server's own ranking was found to differ; otherwise the server
   * ranks the attention order itself.
   */
  attentionTiers?: string[][];
}): McpRegistryListQuery {
  const sortKey = sortKeyFromParams(searchParams);
  const status = new Set(searchParams.getAll("status"));
  const environmentNames = new Set(searchParams.getAll("environment"));
  const authorNames = new Set(searchParams.getAll("author"));
  const issueKinds = new Set(searchParams.getAll("issue"));
  const search = searchParams
    .get("search")
    ?.trim()
    .slice(0, MAX_REGISTRY_SEARCH_LENGTH);
  const labels = parseLabelsParam(searchParams.get("labels"));

  const wantsInstalled = status.has(INSTALLED_STATUS_VALUE);
  const wantsNotInstalled = status.has(NOT_INSTALLED_STATUS_VALUE);
  const facet = selectedAttentionFacet(status);

  // The facet keeps its own rows; the Issue filter keeps rows with one of
  // the chosen kinds — the facet's issues under a facet, any issue otherwise.
  let catalogIds: string[] | undefined;
  if (facet) {
    catalogIds = attentionCatalogIds(issuesByCatalog, { audience: facet });
  }
  if (issueKinds.size > 0) {
    catalogIds = (catalogIds ?? [...issuesByCatalog.keys()]).filter((id) => {
      const issues = issuesByCatalog.get(id) ?? [];
      return (facet ? facetIssues(issues, facet) : issues).some((issue) =>
        issueKinds.has(issue.kind),
      );
    });
  }

  return {
    ...sortParamsForKey(sortKey),
    ...(search ? { search } : {}),
    ...(labels && Object.keys(labels).length > 0 ? { labels } : {}),
    ...(access.access && access.access.length < RESOURCE_ACCESS_RELATIONS.length
      ? { access: access.access }
      : {}),
    ...(access.sharedWith ? { sharedWith: access.sharedWith } : {}),
    ...(access.owner ? { owner: access.owner } : {}),
    ...(environmentNames.size > 0
      ? {
          environmentIds: environments
            .filter((env) => environmentNames.has(env.name))
            .map((env) => env.id),
        }
      : {}),
    ...(authorNames.size > 0 ? authorFilter(authors, authorNames) : {}),
    ...(wantsInstalled !== wantsNotInstalled
      ? { installState: wantsInstalled ? "installed" : "not-installed" }
      : {}),
    ...(catalogIds ? { catalogIds: [...catalogIds].sort() } : {}),
    ...(sortKey === "attention"
      ? attentionTiers
        ? { rankTiers: attentionTiers }
        : {}
      : sortKey === "issue-age"
        ? { rankTiers: issueAgeTiers(issuesByCatalog) }
        : {}),
  };
}

// ===== Internal =====

type RegistryAuthor = {
  authorId: string | null;
  createdByServiceAccountId: string | null;
  authorName?: string | null;
};

/**
 * The ids behind author names. A row shows its service account as the author
 * when one created it, else its human author, so each name maps to whichever
 * of the two the matching rows carry.
 */
function authorFilter(
  authors: ReadonlyArray<RegistryAuthor>,
  names: ReadonlySet<string>,
): Pick<McpRegistryListQuery, "authorIds" | "authorServiceAccountIds"> {
  const userIds = new Set<string>();
  const serviceAccountIds = new Set<string>();
  for (const author of authors) {
    if (!author.authorName || !names.has(author.authorName)) continue;
    if (author.createdByServiceAccountId) {
      serviceAccountIds.add(author.createdByServiceAccountId);
    } else if (author.authorId) {
      userIds.add(author.authorId);
    }
  }
  return {
    authorIds: [...userIds].sort(),
    authorServiceAccountIds: [...serviceAccountIds].sort(),
  };
}

/**
 * Oldest outstanding issue first, one tier per start time. Items whose issues
 * record no start time stay unranked and follow, as they did before.
 */
function issueAgeTiers(issuesByCatalog: Map<string, McpServerIssue[]>) {
  const byTime = new Map<number, string[]>();
  for (const [catalogId, issues] of issuesByCatalog) {
    const oldest = oldestIssueTime(issues);
    if (oldest === null) continue;
    byTime.set(oldest, [...(byTime.get(oldest) ?? []), catalogId]);
  }
  const tiers = [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, ids]) => ids.sort());
  // The API takes at most this many tiers; the rest share the last one.
  return tiers.length <= MAX_RANK_TIERS
    ? tiers
    : [
        ...tiers.slice(0, MAX_RANK_TIERS - 1),
        tiers.slice(MAX_RANK_TIERS - 1).flat(),
      ];
}

const MAX_RANK_TIERS = 1000;

function oldestIssueTime(issues: McpServerIssue[]): number | null {
  let oldest: number | null = null;
  for (const issue of issues) {
    if (!issue.since) continue;
    const at = new Date(issue.since).getTime();
    if (Number.isNaN(at)) continue;
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest;
}
