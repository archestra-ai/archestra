"use client";

import { Plus } from "lucide-react";
import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions } from "@/lib/auth/auth.query";

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
  const isRegistryPage = pathname === "/mcp/registry";
  const [pageActionButton, setActionButton] = useState<React.ReactNode>(null);
  const { data: canReadEnvironments } = useHasPermissions({
    environment: ["read"],
  });
  const { data: canReadNetworkPolicies } = useHasPermissions({
    networkPolicy: ["read"],
  });

  const tabs = [
    { label: "Catalog", href: "/mcp/registry" },
    ...(canReadEnvironments
      ? [{ label: "Environments", href: "/mcp/registry/environments" }]
      : []),
    ...(canReadNetworkPolicies
      ? [
          {
            label: "Network Policies",
            href: "/mcp/registry/network-policies",
          },
        ]
      : []),
  ];
  const contextValue = useMemo(() => ({ setActionButton }), []);
  const registryActionButton = isRegistryPage ? (
    <PermissionButton
      permissions={{ mcpRegistry: ["create"] }}
      onClick={() =>
        window.dispatchEvent(new CustomEvent("mcp-registry:create"))
      }
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
            Self-hosted MCP registry allows you to manage your own list of MCP
            servers and make them available to your agents.
          </>
        }
        tabs={tabs}
        actionButton={registryActionButton ?? pageActionButton}
      >
        {children}
      </PageLayout>
    </McpRegistryLayoutContext.Provider>
  );
}
