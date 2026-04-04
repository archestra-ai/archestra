"use client";

import { Plus } from "lucide-react";
import { usePathname } from "next/navigation";
import { PageLayout } from "@/components/page-layout";
import { PermissionButton } from "@/components/ui/permission-button";

export default function McpCatalogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isRegistryPage = pathname === "/mcp/registry";

  return (
    <PageLayout
      title="MCP Registry"
      description={
        <>
          Self-hosted MCP registry allows you to manage your own list of MCP
          servers and make them available to your agents.
        </>
      }
      actionButton={
        isRegistryPage ? (
          <PermissionButton
            permissions={{ mcpRegistry: ["create"] }}
            onClick={() =>
              window.dispatchEvent(new CustomEvent("mcp-registry:create"))
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            Add MCP Server
          </PermissionButton>
        ) : undefined
      }
    >
      {children}
    </PageLayout>
  );
}
