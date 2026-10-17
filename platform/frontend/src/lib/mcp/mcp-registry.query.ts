import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  hashKey,
  type QueryClient,
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { throwOnApiError } from "@/lib/utils/api";

const {
  getInternalMcpCatalogItem,
  getMcpRegistryIssueIndex,
  getMcpServers,
  searchMcpRegistry,
  searchMcpRegistryIds,
} = archestraApiSdk;

export type McpRegistryRow =
  archestraApiTypes.SearchMcpRegistryResponses["200"]["data"][number];
type McpRegistryPageResponse =
  archestraApiTypes.SearchMcpRegistryResponses["200"];
export type McpRegistryPageParams = NonNullable<
  archestraApiTypes.SearchMcpRegistryData["body"]
>;
/** The list's filters and order, without the page itself. */
export type McpRegistryListQuery = Omit<
  McpRegistryPageParams,
  "limit" | "offset"
>;
/** The issue index as cached: fields that are empty for a row are absent. */
export type McpRegistryIssueIndexWire =
  archestraApiTypes.GetMcpRegistryIssueIndexResponses["200"];
type WireCatalogItem = McpRegistryIssueIndexWire["catalogItems"][number];
type WireServer = McpRegistryIssueIndexWire["servers"][number];
type Nullable<T, K extends keyof T> = Omit<T, K> & {
  [P in K]-?: Exclude<T[P], undefined> | null;
};
/** The issue index as its readers see it, absent fields restored as null. */
export type McpRegistryIssueIndex = {
  catalogItems: Array<
    Nullable<
      WireCatalogItem,
      | "dynamicConnectionMcpServerId"
      | "environmentId"
      | "authorId"
      | "createdByServiceAccountId"
      | "authorName"
      | "icon"
      | "iconUrl"
    > & { alertMutes: NonNullable<WireCatalogItem["alertMutes"]> }
  >;
  servers: Array<
    Nullable<
      WireServer,
      | "ownerId"
      | "teamId"
      | "localInstallationError"
      | "oauthRefreshErrorMessage"
      | "oauthRefreshErrorDescription"
      | "oauthRefreshFailedAt"
    > & { alertMutes: NonNullable<WireServer["alertMutes"]> }
  >;
};

/**
 * Prefix of every registry list query. Lives beside `["mcp-catalog"]` and
 * `["mcp-servers"]` rather than under them, because both of those prefixes
 * are patched as arrays by the install-status cache sync.
 */
export const mcpRegistryQueryKey = ["mcp-registry"] as const;
export const mcpRegistryIssueIndexQueryKey = [
  ...mcpRegistryQueryKey,
  "issue-index",
] as const;

/**
 * Send the registry page's two requests now — the page of rows for the URL
 * (when the URL alone decides it) and the issue index — for the page's hooks
 * to pick up when they mount. Called as the registry route's module loads, so
 * the requests run alongside the session check instead of after the app shell
 * renders. Each is taken once; a failed one (a 401 when signed out) is
 * dropped and the hook fetches as it would have.
 */
export function startMcpRegistryEarlyRequests(params: {
  page: McpRegistryPageParams | null;
  /** False when the document already carries the index (the shell seed). */
  index: boolean;
}): void {
  // One page load's requests; nothing from an earlier one is still wanted.
  earlyRequests.clear();
  if (params.page) {
    keepEarlyRequest(
      hashKey(registryPageQueryKey(params.page, "all")),
      searchMcpRegistry({ body: params.page }),
    );
  }
  if (params.index) {
    keepEarlyRequest(
      hashKey(mcpRegistryIssueIndexQueryKey),
      getMcpRegistryIssueIndex(),
    );
  }
}

/**
 * Put a server-rendered first page and issue index into a query cache under
 * the keys the page's hooks read, so the page renders them without asking
 * again. The page's installs go where `useMcpRegistryPage` puts them.
 */
export function seedMcpRegistryQueries(
  queryClient: QueryClient,
  seed: {
    request: McpRegistryPageParams | null;
    page: McpRegistryPageResponse | null;
    index: McpRegistryIssueIndexWire | null;
  },
): void {
  if (seed.request && seed.page) {
    queryClient.setQueryData(
      registryPageQueryKey(seed.request, "all"),
      seed.page,
    );
    queryClient.setQueryData(
      mcpServersForCatalogsQueryKey(seed.page.data.map((row) => row.id)),
      seed.page.installs,
    );
  }
  if (seed.index) {
    queryClient.setQueryData(mcpRegistryIssueIndexQueryKey, seed.index);
  }
}

/**
 * Marks a document whose server render seeded the registry's queries, so the
 * route does not send the same requests again as it loads.
 */
export const MCP_REGISTRY_SEED_MARKER = "data-mcp-registry-seeded";

/** One page of the registry list. */
export function useMcpRegistryPage(
  params: McpRegistryPageParams,
  options?: {
    enabled?: boolean;
    /**
     * The previous page stays on screen while the next one loads only within
     * one scope: switching to an attention facet must not show the unfiltered
     * rows under it.
     */
    placeholderScope?: string;
    /** Refetch on an interval, e.g. while an install on the page deploys. */
    refetchInterval?: number | false;
  },
) {
  const scope = options?.placeholderScope ?? "";
  const queryClient = useQueryClient();
  return useQuery({
    ...registryPageQueryOptions(queryClient, params, scope),
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey.at(-1) === scope ? previousData : undefined,
  });
}

/**
 * Start the registry's default first page and its issue index, for a link
 * the reader is about to follow: the page then mounts into a warm cache.
 * Nothing is fetched again while the cached copies are fresh.
 */
export function prefetchMcpRegistryQueries(
  queryClient: QueryClient,
  params: McpRegistryPageParams | null,
) {
  return Promise.all([
    params
      ? queryClient.prefetchQuery(
          registryPageQueryOptions(queryClient, params, "all"),
        )
      : undefined,
    queryClient.prefetchQuery(issueIndexQueryOptions()),
  ]);
}

/**
 * Every row matching the list's filters that a bulk action can act on, with
 * the install it would act on. Pass `enabled` so it is only fetched once the
 * reader asks for "all that match".
 */
export function useMcpRegistryMatchingIds(
  query: McpRegistryListQuery,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: [...mcpRegistryQueryKey, "matching-ids", query],
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      const { data, error } = await searchMcpRegistryIds({ body: query });
      throwOnApiError(error);
      return data ?? { data: [], truncated: false };
    },
  });
}

/**
 * Every catalog item and install the viewer can see, reduced to what the
 * issue rule reads. The sidebar count reads it on every page.
 */
export function useMcpRegistryIssueIndex(options?: { enabled?: boolean }) {
  return useQuery({
    ...issueIndexQueryOptions(),
    enabled: options?.enabled ?? true,
    select: normalizeIssueIndex,
  });
}

/**
 * The installs of the catalog items on screen. Keyed under `["mcp-servers"]`
 * with a filter object, like the full list, so install-status pushes patch it
 * and server changes invalidate it.
 */
export function useMcpServersForCatalogs(catalogIds: string[]) {
  const { data: canReadInstallations } = useHasPermissions({
    mcpServerInstallation: ["read"],
  });
  const sortedIds = [...catalogIds].sort();
  return useQuery({
    queryKey: mcpServersForCatalogsQueryKey(sortedIds),
    // No placeholder: the previous page's installs would make the new rows
    // look uninstalled until their own arrive.
    enabled: !!canReadInstallations && sortedIds.length > 0,
    // Seeded by the page request; fetch on its own only once that copy is
    // stale or a server change invalidates it.
    staleTime: PAGE_INSTALLS_STALE_MS,
    queryFn: async () => {
      const { data, error } = await getMcpServers({
        query: { catalogIds: sortedIds, includeAssignedAgents: false },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

function mcpServersForCatalogsQueryKey(catalogIds: string[]) {
  return [
    "mcp-servers",
    { catalogIds: [...catalogIds].sort(), includeAssignedAgents: false },
  ] as const;
}

const PAGE_INSTALLS_STALE_MS = 30_000;

/**
 * Every catalog item the viewer can see, as a name and icon directory: the
 * issue index's items with one display icon each (an emoji, or the link to the
 * item's image). For icon maps and name lookups that used to load the whole
 * catalog with its configuration.
 */
export function useMcpCatalogDirectory(options?: { enabled?: boolean }) {
  const query = useMcpRegistryIssueIndex(options);
  const items = useMemo(
    () =>
      query.data?.catalogItems.map((item) => ({
        id: item.id,
        name: item.name,
        serverType: item.serverType,
        environmentId: item.environmentId,
        icon: item.iconUrl ?? item.icon,
      })),
    [query.data],
  );
  return { ...query, data: items };
}

export type McpCatalogDirectoryItem = NonNullable<
  ReturnType<typeof useMcpCatalogDirectory>["data"]
>[number];

/**
 * The registry rows of the given catalog items, in any number: one request per
 * hundred ids (the page limit). For pickers that show what a record already
 * uses, whose ids can be anywhere in the list.
 */
export function useMcpRegistryRowsByIds(
  ids: string[],
  options?: Pick<McpRegistryListQuery, "includeBuiltIn" | "includeApps">,
) {
  const sortedIds = [...new Set(ids)].sort();
  const idsKey = sortedIds.join(",");
  const chunks: string[][] = [];
  for (let i = 0; i < sortedIds.length; i += MAX_REGISTRY_PAGE_SIZE) {
    chunks.push(sortedIds.slice(i, i + MAX_REGISTRY_PAGE_SIZE));
  }
  const results = useQueries({
    queries: chunks.map((catalogIds) => ({
      queryKey: [...mcpRegistryQueryKey, "rows-by-id", catalogIds, options],
      queryFn: async () => {
        const { data, error } = await searchMcpRegistry({
          body: {
            ...options,
            catalogIds,
            sortBy: "name",
            sortDirection: "asc",
            limit: MAX_REGISTRY_PAGE_SIZE,
            offset: 0,
          },
        });
        throwOnApiError(error, { toastOnError: false });
        return data?.data ?? [];
      },
    })),
    combine: combineRowChunks,
  });

  // A changed id set is a new query with nothing to show, even for the ids
  // it shares with the previous set (`placeholderData` has no previous data
  // to give a new observer inside `useQueries`). Rows already known stay on
  // screen until their new chunk answers; a removed id leaves at once.
  const knownRows = useRef(new Map<string, McpRegistryRow>());
  const everyChunkAnswered = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: idsKey stands for sortedIds
  const data = useMemo(() => {
    const requested = new Set(sortedIds);
    const answered = new Set<string>();
    const rows: McpRegistryRow[] = [];
    results.chunks.forEach((chunk, i) => {
      if (!chunk.data) return;
      for (const id of chunks[i] ?? []) answered.add(id);
      for (const row of chunk.data) rows.push(row);
    });
    for (const [id, row] of knownRows.current) {
      if (requested.has(id) && !answered.has(id)) rows.push(row);
    }
    const next = new Map<string, McpRegistryRow>();
    for (const row of rows) next.set(row.id, row);
    knownRows.current = next;
    return rows;
  }, [results.chunks, idsKey]);
  if (!results.isPending) everyChunkAnswered.current = true;

  return {
    data,
    /** Some requested chunk has not answered yet. */
    isPending: results.isPending,
    /**
     * Every chunk has answered once: later id changes keep the known rows,
     * so a loading state should wait only for this.
     */
    hasLoaded: everyChunkAnswered.current,
    isError: results.isError,
    refetch: results.refetch,
  };
}

export function catalogItemQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["mcp-catalog", "item", id],
    queryFn: async () => {
      const { data, error } = await getInternalMcpCatalogItem({
        path: { id },
      });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
  });
}

/** One catalog item with its full configuration, as the install flows need it. */
export function useInternalMcpCatalogItem(id: string | null | undefined) {
  return useQuery({
    ...catalogItemQueryOptions(id ?? ""),
    enabled: !!id,
    select: (item) => (item ? toFullCatalogItem(item) : null),
  });
}

/** Load one full catalog item through the query cache, for event handlers. */
export async function fetchInternalMcpCatalogItem(
  queryClient: QueryClient,
  id: string,
): Promise<FullCatalogItem | null> {
  // An action often loads the item twice in a row (a list loads it, then the
  // view it opens does); a few seconds of freshness lets the second reuse it.
  const item = await queryClient.fetchQuery({
    ...catalogItemQueryOptions(id),
    staleTime: ACTION_ITEM_STALE_TIME_MS,
  });
  return item ? toFullCatalogItem(item) : null;
}

/** The list-shaped catalog item the install and reinstall dialogs take. */
export type FullCatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

function toFullCatalogItem(
  item: archestraApiTypes.GetInternalMcpCatalogItemResponses["200"],
): FullCatalogItem {
  return {
    ...item,
    toolCount: item.toolCount ?? 0,
    skillCount: item.skillCount ?? 0,
  };
}

// ===== Internal =====

/** The most rows one registry page request returns. */
const MAX_REGISTRY_PAGE_SIZE = 100;

function registryPageQueryOptions(
  queryClient: QueryClient,
  params: McpRegistryPageParams,
  scope: string,
) {
  const queryKey = registryPageQueryKey(params, scope);
  return queryOptions({
    queryKey,
    queryFn: async () => {
      const fetchPage = () => searchMcpRegistry({ body: params });
      const { data, error } =
        ((await takeEarlyRequest(queryKey)) as
          | Awaited<ReturnType<typeof fetchPage>>
          | undefined) ?? (await fetchPage());
      // The registry renders its own error state with a retry.
      throwOnApiError(error, { toastOnError: false });
      // The page's installs arrive with it. Seed the page-scoped installs
      // query so it needs no request of its own, while install-status pushes
      // keep patching it like any other server list.
      if (data) {
        queryClient.setQueryData(
          mcpServersForCatalogsQueryKey(data.data.map((row) => row.id)),
          data.installs,
        );
      }
      return data;
    },
  });
}

function issueIndexQueryOptions() {
  return queryOptions({
    queryKey: mcpRegistryIssueIndexQueryKey,
    queryFn: async (): Promise<McpRegistryIssueIndexWire> => {
      const fetchIndex = () => getMcpRegistryIssueIndex();
      const { data, error } =
        ((await takeEarlyRequest(mcpRegistryIssueIndexQueryKey)) as
          | Awaited<ReturnType<typeof fetchIndex>>
          | undefined) ?? (await fetchIndex());
      throwOnApiError(error, { toastOnError: false });
      return data ?? { catalogItems: [], servers: [] };
    },
  });
}

function registryPageQueryKey(params: McpRegistryPageParams, scope: string) {
  return [...mcpRegistryQueryKey, "page", params, scope] as const;
}

/** Requests started before their hook mounted, by query key hash. */
const earlyRequests = new Map<string, Promise<unknown>>();

/**
 * Hold an early request for its hook; one nobody takes (the URL changed
 * before the page mounted) is dropped after a while.
 */
function keepEarlyRequest(key: string, request: Promise<unknown>) {
  earlyRequests.set(key, request);
  setTimeout(() => {
    if (earlyRequests.get(key) === request) earlyRequests.delete(key);
  }, EARLY_REQUEST_TTL_MS);
}

const EARLY_REQUEST_TTL_MS = 30_000;

/**
 * The early response for this query, once; undefined when none was started
 * or it failed, so the caller fetches as usual.
 */
async function takeEarlyRequest(
  queryKey: readonly unknown[],
): Promise<unknown> {
  const key = hashKey(queryKey);
  const early = earlyRequests.get(key);
  if (!early) return undefined;
  earlyRequests.delete(key);
  try {
    const response = (await early) as { error?: unknown };
    return response.error ? undefined : response;
  } catch {
    return undefined;
  }
}

/** Module-level, so `useQueries` can keep its combined result between renders. */
function combineRowChunks(
  results: Array<{
    data: McpRegistryRow[] | undefined;
    isPending: boolean;
    isError: boolean;
    refetch: () => Promise<unknown>;
  }>,
) {
  return {
    chunks: results.map((result) => ({ data: result.data })),
    isPending: results.some((result) => result.isPending),
    isError: results.some((result) => result.isError),
    refetch: () => Promise.all(results.map((result) => result.refetch())),
  };
}

function normalizeIssueIndex(
  wire: McpRegistryIssueIndexWire,
): McpRegistryIssueIndex {
  return {
    catalogItems: wire.catalogItems.map((item) => ({
      ...item,
      dynamicConnectionMcpServerId: item.dynamicConnectionMcpServerId ?? null,
      environmentId: item.environmentId ?? null,
      authorId: item.authorId ?? null,
      createdByServiceAccountId: item.createdByServiceAccountId ?? null,
      icon: item.icon ?? null,
      iconUrl: item.iconUrl ?? null,
      authorName: item.authorName ?? null,
      alertMutes: item.alertMutes ?? [],
    })),
    servers: wire.servers.map((server) => ({
      ...server,
      ownerId: server.ownerId ?? null,
      teamId: server.teamId ?? null,
      localInstallationError: server.localInstallationError ?? null,
      oauthRefreshErrorMessage: server.oauthRefreshErrorMessage ?? null,
      oauthRefreshErrorDescription: server.oauthRefreshErrorDescription ?? null,
      oauthRefreshFailedAt: server.oauthRefreshFailedAt ?? null,
      alertMutes: server.alertMutes ?? [],
    })),
  };
}

const ACTION_ITEM_STALE_TIME_MS = 5_000;
