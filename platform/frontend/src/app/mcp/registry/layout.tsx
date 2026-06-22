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
  const isRegistryPage = pathname === "/mcp/registry";
  const [pageActionButton, setActionButton] = useState<React.ReactNode>(null);
  const contextValue = useMemo(() => ({ setActionButton }), []);
  const registryActionButton = isRegistryPage ? (
    <PermissionButton
      permissions={{ mcpRegistry: ["create"] }}
      onClick={() => router.push("/mcp/registry/new")}
    >
      <Plus className="h-4 w-4" />
      Add MCP Server
    </PermissionButton>
  ) : undefined;

  // Detail, edit, and create pages carry their own headers — skip the
  // registry page header band and render bare content for them.
  const isFullPageRoute =
    !isRegistryPage &&
    !pathname.startsWith("/mcp/registry/installation-requests");
  if (isFullPageRoute) {
    return (
      <McpRegistryLayoutContext.Provider value={contextValue}>
        {/* No overflow wrapper: <main> is the scrollport, so in-page
            `sticky bottom-0` footers (wizard CTAs) pin to the viewport. */}
        <div className="mx-auto w-full px-6 py-6 md:px-6">{children}</div>
      </McpRegistryLayoutContext.Provider>
    );
  }

  return (
    <McpRegistryLayoutContext.Provider value={contextValue}>
      <PageLayout
        title="MCP Registry"
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
