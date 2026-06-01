"use client";

import { Plus } from "lucide-react";
import { usePathname } from "next/navigation";
import { PageLayout } from "@/components/page-layout";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { usePresetEntityName } from "@/lib/organization.query";

export default function McpCatalogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isRegistryPage = pathname === "/mcp/registry";
  const { configured, plural } = usePresetEntityName();
  const { data: canManageOrgStructure } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const { data: canManageEnvironments } = useHasPermissions({
    environment: ["create", "update", "delete"],
  });

  const tabs = [
    { label: "Catalog", href: "/mcp/registry" },
    ...(canManageOrgStructure
      ? [
          {
            label: configured ? plural : "Organization Structure",
            href: "/mcp/registry/org-structure",
          },
        ]
      : []),
    ...(canManageEnvironments
      ? [{ label: "Environments", href: "/mcp/registry/environments" }]
      : []),
  ];

  return (
    <PageLayout
      title="MCP Registry"
      description={
        <>
          Self-hosted MCP registry allows you to manage your own list of MCP
          servers and make them available to your agents.
        </>
      }
      tabs={tabs}
      actionButton={
        isRegistryPage ? (
          <PermissionButton
            permissions={{ mcpRegistry: ["create"] }}
            onClick={() =>
              window.dispatchEvent(new CustomEvent("mcp-registry:create"))
            }
          >
            <Plus className="h-4 w-4" />
            Add MCP Server
          </PermissionButton>
        ) : undefined
      }
    >
      {children}
    </PageLayout>
  );
}
