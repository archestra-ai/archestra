import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";
import { headers } from "next/headers";
import { SavedTableCardViewModesProvider } from "@/components/table-card-view";
import { readSavedTableCardViewMode } from "@/components/table-card-view.server";
import { isShellSeedRoute, SHELL_SEED_HEADER } from "@/lib/auth/shell-seed";
import {
  MCP_REGISTRY_SEED_MARKER,
  seedMcpRegistryQueries,
} from "@/lib/mcp/mcp-registry.query";
import { MCP_REGISTRY_VIEW_STORAGE_KEY } from "./_parts/registry-list-params";
import McpRegistryClient from "./page.client";
import { prefetchMcpRegistryFirstPage } from "./prefetch-first-page";

export const dynamic = "force-dynamic";

export default async function McpRegistryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The first page and the issue index, so the first rows are in the HTML.
  // Best-effort: without them the page loads its own, as it always could.
  // Only a full page load renders its rows on the server (the proxy marks
  // those, and the root layout resolves the shell for them). A client-side
  // navigation or route prefetch gets the page without data: the link's own
  // prefetch fetches the first page in the browser, once.
  const isDocumentLoad = isShellSeedRoute(
    (await headers()).get(SHELL_SEED_HEADER),
  );
  const [seed, savedView] = await Promise.all([
    isDocumentLoad
      ? searchParams.then(prefetchMcpRegistryFirstPage)
      : { request: null, page: null, index: null },
    readSavedTableCardViewMode(MCP_REGISTRY_VIEW_STORAGE_KEY),
  ]);
  const queryClient = new QueryClient();
  seedMcpRegistryQueries(queryClient, seed);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      {/* Tells the route's early requests what this document already
          carries: on a full page load the shell seed holds the index, and
          the page seed the first page when the URL alone decides it. */}
      {isDocumentLoad && (
        <div
          hidden
          {...{ [MCP_REGISTRY_SEED_MARKER]: seed.page ? "page" : "index" }}
        />
      )}
      {/* The saved table/card view, so the server renders the same one. */}
      <SavedTableCardViewModesProvider
        modes={{ [MCP_REGISTRY_VIEW_STORAGE_KEY]: savedView }}
      >
        <McpRegistryClient />
      </SavedTableCardViewModesProvider>
    </HydrationBoundary>
  );
}
