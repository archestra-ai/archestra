"use client";

import { Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { PageLayout } from "@/components/page-layout";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  ATTENTION_FACET_STATUS_VALUES,
  REGISTRY_STATUS_PARAM,
} from "./_parts/registry-list-controls";

/**
 * The registry used to answer "what needs me?" on a second tab, which meant
 * the same server was counted on the tab and listed on the tab but missing
 * from the list everyone actually works in. The tab is gone: the default sort
 * puts actionable rows first, while sidebar and legacy links can still narrow
 * the one list.
 */
const RETIRED_ATTENTION_TAB_PARAM = "tab";
const RETIRED_ATTENTION_TAB_VALUE = "attention";

export default function McpCatalogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMainRegistry = pathname === "/mcp/registry";

  // Path-exact: `tab` means something else on the server detail page, so only
  // the list route redirects. `replace` keeps the retired URL out of history,
  // where Back would bounce the user straight through it again.
  const retiredAttentionTab =
    isMainRegistry &&
    searchParams.get(RETIRED_ATTENTION_TAB_PARAM) ===
      RETIRED_ATTENTION_TAB_VALUE;
  useEffect(() => {
    if (!retiredAttentionTab) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete(RETIRED_ATTENTION_TAB_PARAM);
    params.set(REGISTRY_STATUS_PARAM, ATTENTION_FACET_STATUS_VALUES.you);
    router.replace(`/mcp/registry?${params.toString()}`, { scroll: false });
  }, [retiredAttentionTab, searchParams, router]);

  const registrySubPath = pathname.startsWith("/mcp/registry/")
    ? pathname.slice("/mcp/registry/".length)
    : null;

  // The server detail page renders its own PageLayout, whose header band spans
  // the full width and supplies its own padding. Wrapping it in the padded
  // container below would inset that band and double its horizontal padding,
  // so this route is handed through untouched.
  const isServerDetailPage =
    !!registrySubPath &&
    !registrySubPath.includes("/") &&
    !REGISTRY_NON_DETAIL_ROUTES.includes(registrySubPath);
  if (isServerDetailPage) {
    return <>{children}</>;
  }

  // Detail and wizard routes render PageLayout themselves. Keep them bare so
  // the shared shell owns the full-width header, padding, and sticky footer.
  const isFullPage = pathname.startsWith("/mcp/registry/");
  if (isFullPage) {
    return <>{children}</>;
  }

  return isMainRegistry ? (
    <McpRegistryListLayout onAdd={() => router.push("/mcp/registry/new")}>
      {children}
    </McpRegistryListLayout>
  ) : (
    <PageLayout
      title="MCP Registry"
      description={
        <>
          Manage your own list of MCP servers and make them available to agents.
        </>
      }
    >
      {children}
    </PageLayout>
  );
}

function McpRegistryListLayout({
  children,
  onAdd,
}: {
  children: React.ReactNode;
  onAdd: () => void;
}) {
  return (
    <PageLayout
      title="MCP Registry"
      description="Manage your own list of MCP servers and make them available to agents."
      actionButton={
        <PermissionButton
          permissions={{ mcpRegistry: ["create"] }}
          onClick={onAdd}
        >
          <Plus className="h-4 w-4" />
          <span>Add MCP Server</span>
        </PermissionButton>
      }
    >
      {children}
    </PageLayout>
  );
}

/**
 * Single-segment routes under `/mcp/registry/` that are not a server id, and so
 * are not the server detail page.
 */
const REGISTRY_NON_DETAIL_ROUTES = ["new", "catalog"];
