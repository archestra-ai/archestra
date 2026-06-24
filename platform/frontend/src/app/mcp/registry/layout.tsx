"use client";

import { Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
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
  const isBetaRegistry = pathname === "/mcp/registry/beta";
  const [pageActionButton, setActionButton] = useState<React.ReactNode>(null);
  const contextValue = useMemo(() => ({ setActionButton }), []);

  // Beta detail/edit/new/catalog pages carry their own headers — render bare
  // content (no overflow wrapper, so in-page sticky footers pin to the viewport).
  const isBetaFullPage = pathname.startsWith("/mcp/registry/beta/");
  if (isBetaFullPage) {
    return (
      <McpRegistryLayoutContext.Provider value={contextValue}>
        <div className="mx-auto w-full px-6 py-6 md:px-6">{children}</div>
      </McpRegistryLayoutContext.Provider>
    );
  }

  // Main list opens the create dialog (the legacy InternalMCPCatalog listens for
  // the event); the beta list navigates to the routed setup wizard instead.
  const registryActionButton = isMainRegistry ? (
    <PermissionButton
      permissions={{ mcpRegistry: ["create"] }}
      onClick={() =>
        window.dispatchEvent(new CustomEvent("mcp-registry:create"))
      }
    >
      <Plus className="h-4 w-4" />
      Add MCP Server
    </PermissionButton>
  ) : isBetaRegistry ? (
    <PermissionButton
      permissions={{ mcpRegistry: ["create"] }}
      onClick={() => router.push("/mcp/registry/beta/new")}
    >
      <Plus className="h-4 w-4" />
      Add MCP Server
    </PermissionButton>
  ) : undefined;

  const title = isBetaRegistry ? (
    <span className="flex items-center gap-2">
      MCP Registry
      <Badge variant="secondary">Beta</Badge>
    </span>
  ) : (
    "MCP Registry"
  );

  return (
    <McpRegistryLayoutContext.Provider value={contextValue}>
      <PageLayout
        title={title}
        description={
          <>
            Self-hosted MCP registry allows you to manage your own list of MCP
            servers and make them available to your agents.
          </>
        }
        actionButton={registryActionButton ?? pageActionButton}
      >
        {children}
      </PageLayout>
    </McpRegistryLayoutContext.Provider>
  );
}
