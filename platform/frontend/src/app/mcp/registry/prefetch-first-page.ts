import { archestraApiSdk } from "@archestra/shared";
import { getServerApiHeaders } from "@/lib/utils/server";
import { withServerSeedDeadline } from "@/lib/utils/server-seed-timeout";
import { registryPageRequestFromUrl } from "./_parts/registry-list-query";

/**
 * The registry page's only server call: the paged search for the URL's page
 * (the server ranks the default attention order) — a few KB, never the full
 * catalog or install lists. The issue index comes with the signed-in shell
 * (the sidebar badge reads it above the page; see `prefetchShellSeed`). A URL
 * whose request maps names or issues through data the browser loads gets no
 * page. Any failure (signed out, no access, backend down) seeds nothing and
 * the page fetches as usual.
 */
export async function prefetchMcpRegistryFirstPage(
  searchParams: Record<string, string | string[] | undefined>,
) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(searchParams)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry !== undefined) params.append(name, entry);
    }
  }
  const request = registryPageRequestFromUrl(params);
  if (!request) return { request, page: null, index: null };
  try {
    const headers = await getServerApiHeaders();
    const page = await withServerSeedDeadline((signal) =>
      archestraApiSdk.searchMcpRegistry({ headers, body: request, signal }),
    );
    return { request, page: page.data ?? null, index: null };
  } catch {
    return { request, page: null, index: null };
  }
}
