import type { Permissions } from "@archestra/shared";
import type { QueryClient } from "@tanstack/react-query";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { hasPermissions } from "@/lib/auth/auth.utils";
import { prefetchMcpRegistryQueries } from "@/lib/mcp/mcp-registry.query";
import { registryPageRequestFromUrl } from "./registry-list-query";

/**
 * Warm the registry list for a link to it (`/mcp/registry`, with any query):
 * the page the link's URL asks for and the issue index, so following the link
 * renders rows without waiting on a request. Skipped for a reader who may not
 * open the registry.
 */
export function prefetchMcpRegistry(queryClient: QueryClient, href: string) {
  const session = queryClient.getQueryData<{ user?: unknown } | null>(
    authQueryKeys.session(),
  );
  const permissions = queryClient.getQueryData<Permissions>(
    authQueryKeys.userPermissions(),
  );
  if (!session?.user || !hasPermissions(permissions, { mcpRegistry: ["read"] }))
    return;
  const url = new URL(href, "http://registry.invalid");
  return prefetchMcpRegistryQueries(
    queryClient,
    registryPageRequestFromUrl(url.searchParams),
  );
}
