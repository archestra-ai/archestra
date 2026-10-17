import type { archestraApiTypes } from "@archestra/shared";
import { type HttpHandler, HttpResponse, http } from "msw";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];
type Install = archestraApiTypes.GetMcpServersResponses["200"][number];
type SearchBody = NonNullable<archestraApiTypes.SearchMcpRegistryData["body"]>;
type SearchResponse = archestraApiTypes.SearchMcpRegistryResponses["200"];
type RegistryRow = SearchResponse["data"][number];
type IssueIndex = archestraApiTypes.GetMcpRegistryIssueIndexResponses["200"];

/**
 * The registry reads a paged search, a slim issue index and single items by
 * id. The mocks derive all three from the two full-list endpoints, read
 * through the same mock chain, so a spec that overrides the catalog or the
 * install list shapes these reads too and keeps describing its data the way
 * it always has.
 */
export const registryHandlers: HttpHandler[] = [
  http.get(
    "/api/internal_mcp_catalog/registry/issue-index",
    async ({ request }) => {
      const { items, installs } = await readLists(request);
      const index: IssueIndex = {
        catalogItems: items.map((item) =>
          withoutNulls({
            id: item.id,
            name: item.name,
            serverType: item.serverType,
            multitenant: item.multitenant,
            dynamicConnectionMcpServerId: item.dynamicConnectionMcpServerId,
            environmentId: item.environmentId,
            authorId: item.authorId,
            createdByServiceAccountId: item.createdByServiceAccountId,
            authorName: item.authorName,
          }),
        ) as IssueIndex["catalogItems"],
        servers: installs
          .filter((server) => !!server.catalogId)
          .map((server) =>
            withoutNulls({
              id: server.id,
              name: server.name,
              catalogId: server.catalogId,
              scope: server.scope,
              localInstallationStatus: server.localInstallationStatus,
              updatedAt: server.updatedAt,
              ownerId: server.ownerId,
              teamId: server.teamId,
              localInstallationError: server.localInstallationError,
              oauthRefreshError: server.oauthRefreshError,
              oauthRefreshErrorMessage: server.oauthRefreshErrorMessage,
              oauthRefreshErrorDescription: server.oauthRefreshErrorDescription,
              oauthRefreshFailedAt: server.oauthRefreshFailedAt,
              canUseCredential: server.canUseCredential ?? true,
            }),
          ) as IssueIndex["servers"],
      };
      return HttpResponse.json(index);
    },
  ),
  http.post(
    "/api/internal_mcp_catalog/registry/search",
    async ({ request }) => {
      const body = (await request.json()) as SearchBody;
      const { items, installs } = await readLists(request);
      const matching = sortRows(
        filterItems(items, installs, body),
        installs,
        body,
      );
      const limit = body.limit ?? 20;
      const offset = body.offset ?? 0;
      const page = matching.slice(offset, offset + limit);
      const pageIds = new Set(page.map((item) => item.id));
      const response: SearchResponse = {
        data: page.map((item) => rowOf(item, installs)),
        pagination: {
          currentPage: Math.floor(offset / limit) + 1,
          limit,
          total: matching.length,
          totalPages: Math.max(1, Math.ceil(matching.length / limit)),
          hasNext: offset + limit < matching.length,
          hasPrev: offset > 0,
        },
        selectableTotal: matching.filter((item) =>
          installs.some((server) => server.catalogId === item.id),
        ).length,
        installs: installs.filter(
          (server) => !!server.catalogId && pageIds.has(server.catalogId),
        ) as SearchResponse["installs"],
      };
      return HttpResponse.json(response);
    },
  ),
  http.post(
    "/api/internal_mcp_catalog/registry/search/ids",
    async ({ request }) => {
      const body = (await request.json()) as SearchBody;
      const { items, installs } = await readLists(request);
      const data = filterItems(items, installs, body).flatMap((item) => {
        const primary = installs.find((server) => server.catalogId === item.id);
        return primary
          ? [{ id: item.id, name: item.name, primaryServerId: primary.id }]
          : [];
      });
      return HttpResponse.json({ data, truncated: false });
    },
  ),
  http.get("/api/internal_mcp_catalog/:id/icon", () =>
    HttpResponse.text("Not found", { status: 404 }),
  ),
  http.get("/api/internal_mcp_catalog/:id", async ({ request, params }) => {
    const { items } = await readLists(request);
    const item = items.find((candidate) => candidate.id === params.id);
    return item
      ? HttpResponse.json(item)
      : HttpResponse.json(
          { error: { message: "Not found", type: "api_not_found_error" } },
          { status: 404 },
        );
  }),
];

/**
 * The two full lists, read through the mock chain: in the browser through the
 * worker, on the server through the mock backend's in-process resolver.
 */
async function readLists(
  request: Request,
): Promise<{ items: CatalogItem[]; installs: Install[] }> {
  const [items, installs] = await Promise.all([
    readMockJson<CatalogItem[]>(request, "/api/internal_mcp_catalog"),
    readMockJson<Install[]>(request, "/api/mcp_server"),
  ]);
  return { items: items ?? [], installs: installs ?? [] };
}

async function readMockJson<T>(
  request: Request,
  path: string,
): Promise<T | null> {
  const url = new URL(path, request.url);
  let response: Response | null;
  if (typeof window === "undefined") {
    const { resolveMockResponse } = await import("./resolve");
    response = await resolveMockResponse(new Request(url));
  } else {
    response = await fetch(url);
  }
  if (!response?.ok) return null;
  return (await response.json()) as T;
}

/**
 * The search, id, environment, author, label and install-state filters. The
 * access, owner, shared-with and service-account filters are not mocked: the
 * backend route tests cover them.
 */
function filterItems(
  items: CatalogItem[],
  installs: Install[],
  body: SearchBody,
): CatalogItem[] {
  const search = body.search?.trim().toLowerCase();
  return items.filter((item) => {
    if (search && !item.name.toLowerCase().includes(search)) return false;
    if (body.catalogIds && !body.catalogIds.includes(item.id)) return false;
    if (
      body.environmentIds &&
      !body.environmentIds.includes(item.environmentId ?? "")
    ) {
      return false;
    }
    if (body.authorIds && !body.authorIds.includes(item.authorId ?? "")) {
      return false;
    }
    for (const [key, values] of Object.entries(body.labels ?? {})) {
      if (
        !item.labels.some(
          (label) => label.key === key && values.includes(label.value),
        )
      ) {
        return false;
      }
    }
    if (body.installState) {
      const installed = installs.some(
        (server) =>
          server.catalogId === item.id && server.canUseCredential !== false,
      );
      if (installed !== (body.installState === "installed")) return false;
    }
    return true;
  });
}

/**
 * Name, creation time and tool count sort as the server does. The attention
 * order follows `rankTiers` when the request sends them; otherwise items with
 * an install that failed to start or lost its sign-in come first. That is a
 * reduced form of the server's issue rule, enough for fixtures to place a
 * broken server at the top.
 */
function sortRows(
  items: CatalogItem[],
  installs: Install[],
  body: SearchBody,
): CatalogItem[] {
  const direction = body.sortDirection === "desc" ? -1 : 1;
  const byName = (a: CatalogItem, b: CatalogItem) =>
    a.name.localeCompare(b.name);
  const sortBy = body.sortBy ?? "attention";
  if (sortBy === "name") {
    return [...items].sort((a, b) => direction * byName(a, b));
  }
  if (sortBy === "createdAt") {
    return [...items].sort(
      (a, b) =>
        direction * (Date.parse(a.createdAt) - Date.parse(b.createdAt)) ||
        byName(a, b),
    );
  }
  if (sortBy === "toolCount") {
    return [...items].sort(
      (a, b) => direction * (a.toolCount - b.toolCount) || byName(a, b),
    );
  }
  const tierOf = (item: CatalogItem) => {
    if (body.rankTiers) {
      const tier = body.rankTiers.findIndex((ids) => ids.includes(item.id));
      return tier === -1 ? body.rankTiers.length : tier;
    }
    const needsAttention = installs.some(
      (server) =>
        server.catalogId === item.id &&
        (server.localInstallationStatus === "error" ||
          !!server.oauthRefreshFailedAt),
    );
    return needsAttention ? 0 : 1;
  };
  return [...items].sort((a, b) => tierOf(a) - tierOf(b) || byName(a, b));
}

function rowOf(item: CatalogItem, installs: Install[]): RegistryRow {
  const own = installs.filter((server) => server.catalogId === item.id);
  const imageIcon = item.icon?.startsWith("data:") ?? false;
  return {
    ...item,
    icon: imageIcon ? null : (item.icon ?? null),
    iconUrl: imageIcon
      ? `/api/internal_mcp_catalog/${item.id}/icon?v=mock`
      : null,
    alertMutes: [],
    effectiveActions: item.effectiveActions ?? [],
    imageApprovalRequired: false,
    bindsCredential: false,
    enterpriseManaged: !!item.enterpriseManagedConfig,
    install: {
      visibleCount: own.length,
      installedForViewer: own.some(
        (server) => server.canUseCredential !== false,
      ),
      primaryServerId: own[0]?.id ?? null,
    },
  } as RegistryRow;
}

/** The issue index leaves empty fields out, like the server. */
function withoutNulls<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, field]) => field !== null && field !== undefined,
    ),
  );
}
