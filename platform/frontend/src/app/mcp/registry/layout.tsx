"use client";

import { Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { PermissionButton } from "@/components/ui/permission-button";

type McpRegistryLayoutContextType = {
  setActionButton: (button: React.ReactNode) => void;
};

const McpRegistryLayoutContext = createContext<McpRegistryLayoutContextType>({
  setActionButton: () => {},
});

export function useSetMcpRegistryAction() {
  return useContext(McpRegistryLayoutContext).setActionButton;
}

export default function McpCatalogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const isMainRegistry = pathname === "/mcp/registry";
  const [pageActionButton, setActionButton] = useState<React.ReactNode>(null);
  const contextValue = useMemo(() => ({ setActionButton }), []);

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
