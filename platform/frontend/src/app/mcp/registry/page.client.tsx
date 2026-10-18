"use client";

import { appLifecycle } from "@/lib/app-lifecycle";
import {
  MCP_REGISTRY_SEED_MARKER,
  startMcpRegistryEarlyRequests,
} from "@/lib/mcp/mcp-registry.query";
import { InternalMCPCatalog } from "./_parts/InternalMCPCatalog";
import { registryPageRequestFromUrl } from "./_parts/registry-list-query";

// A full page load whose server render could not seed the list evaluates this
// module while the app is still checking the session: start the page's
// requests now, so the page mounts into a warm cache instead of asking only
// after the shell renders. A client-side navigation needs none of this: the
// link that started it prefetched the first page.
if (
  typeof window !== "undefined" &&
  window.location.pathname === "/mcp/registry" &&
  !appLifecycle.hasRendered
) {
  const seeded = document
    .querySelector(`[${MCP_REGISTRY_SEED_MARKER}]`)
    ?.getAttribute(MCP_REGISTRY_SEED_MARKER);
  // The marker is only in the HTML when the server rendered the page, which
  // it does only with the signed-in shell resolved — index included.
  if (seeded !== "page") {
    startMcpRegistryEarlyRequests({
      page: registryPageRequestFromUrl(
        new URLSearchParams(window.location.search),
      ),
      index: seeded === undefined || seeded === null,
    });
  }
}

export default function McpRegistryClient() {
  return (
    <div>
      <InternalMCPCatalog />
    </div>
  );
}
