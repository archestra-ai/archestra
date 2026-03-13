"use client";

import { Plus } from "lucide-react";
import { usePathname } from "next/navigation";
import { PageLayout } from "@/components/page-layout";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions } from "@/lib/auth.query";

export default function McpCatalogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: userIsMcpServerAdmin } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });

  const pathname = usePathname();
  const isRegistryPage = pathname === "/mcp/registry";

  return (
    <PageLayout
      title="MCP Registry"
      description={
        <>
          Self-hosted MCP registry allows you to manage your own list of MCP
          servers and make them available to your agents.
          <br />
          You can also{" "}
          {userIsMcpServerAdmin
            ? "review and manage installation requests from your team members"
            : "view your installation requests and their status"}
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
