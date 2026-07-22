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

  // Detail/edit/new/catalog pages carry their own headers — render bare
  // content (no overflow wrapper, so in-page sticky footers pin to the viewport).
  // Installation-requests pages keep the shared PageLayout chrome.
  const isFullPage =
    pathname.startsWith("/mcp/registry/") &&
    !pathname.startsWith("/mcp/registry/installation-requests");
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
