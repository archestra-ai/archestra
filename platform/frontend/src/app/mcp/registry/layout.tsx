"use client";

import { Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { PermissionButton } from "@/components/ui/permission-button";

type McpRegistryLayoutContextType = {
  setActionButton: (button: React.ReactNode) => void;
  /**
   * How many servers the viewer must act on, shown on the root's
   * "Needs attention" tab. Reported by the list page, which owns the live
   * deployment-status subscription the count depends on.
   */
  setAttentionCount: (count: number) => void;
};

const McpRegistryLayoutContext = createContext<McpRegistryLayoutContextType>({
  setActionButton: () => {},
  setAttentionCount: () => {},
});

export function useSetMcpRegistryAction() {
  return useContext(McpRegistryLayoutContext).setActionButton;
}

export function useSetMcpRegistryAttentionCount() {
  return useContext(McpRegistryLayoutContext).setAttentionCount;
}

/** Query param selecting the root's Needs-attention tab. */
export const MCP_REGISTRY_TAB_PARAM = "tab";
export const MCP_REGISTRY_ATTENTION_TAB = "attention";

export default function McpCatalogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMainRegistry = pathname === "/mcp/registry";
  // Tab hrefs carry the list's other params (search, labels) so PageLayout's
  // exact-match active check works and switching tabs keeps the filters.
  const rootTabHref = (tab: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (tab) params.set(MCP_REGISTRY_TAB_PARAM, tab);
    else params.delete(MCP_REGISTRY_TAB_PARAM);
    const qs = params.toString();
    return qs ? `/mcp/registry?${qs}` : "/mcp/registry";
  };
  const [pageActionButton, setActionButton] = useState<React.ReactNode>(null);
  const [attentionCount, setAttentionCount] = useState(0);
  const contextValue = useMemo(
    () => ({ setActionButton, setAttentionCount }),
    [],
  );

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
    return (
      <McpRegistryLayoutContext.Provider value={contextValue}>
        {children}
      </McpRegistryLayoutContext.Provider>
    );
  }

  // Edit/new/catalog pages carry their own headers — render bare content (no
  // overflow wrapper, so in-page sticky footers pin to the viewport).
  const isFullPage = pathname.startsWith("/mcp/registry/");
  if (isFullPage) {
    return (
      <McpRegistryLayoutContext.Provider value={contextValue}>
        <div className="mx-auto w-full px-6 py-6 md:px-6">{children}</div>
      </McpRegistryLayoutContext.Provider>
    );
  }

  // The main list navigates to the routed setup wizard.
  const registryActionButton = isMainRegistry ? (
    <PermissionButton
      permissions={{ mcpRegistry: ["create"] }}
      onClick={() => router.push("/mcp/registry/new")}
    >
      <Plus className="h-4 w-4" />
      Add MCP Server
    </PermissionButton>
  ) : undefined;

  return (
    <McpRegistryLayoutContext.Provider value={contextValue}>
      <PageLayout
        title="MCP Registry"
        description={
          <>
            Manage your own list of MCP servers and make them available to
            agents.
          </>
        }
        actionButton={registryActionButton ?? pageActionButton}
        tabs={
          isMainRegistry
            ? [
                { label: "All servers", href: rootTabHref(null) },
                {
                  label: (
                    <span className="flex items-center gap-1.5">
                      <span>Needs attention</span>
                      {attentionCount > 0 && (
                        <span
                          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-semibold text-destructive-foreground tabular-nums"
                          data-testid="mcp-registry-attention-tab-count"
                        >
                          {attentionCount}
                        </span>
                      )}
                    </span>
                  ),
                  href: rootTabHref(MCP_REGISTRY_ATTENTION_TAB),
                  testId: "mcp-registry-attention-tab",
                },
              ]
            : []
        }
      >
        {children}
      </PageLayout>
    </McpRegistryLayoutContext.Provider>
  );
}

/**
 * Single-segment routes under `/mcp/registry/` that are not a server id, and so
 * are not the server detail page.
 */
const REGISTRY_NON_DETAIL_ROUTES = ["new", "catalog"];
