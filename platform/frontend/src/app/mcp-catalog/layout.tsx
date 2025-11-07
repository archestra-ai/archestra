"use client";

import { PageLayout } from "@/components/page-layout";
import { useHasPermissions } from "@/lib/auth.query";

export default function McpCatalogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: userIsMcpServerAdmin } = useHasPermissions({
    mcpServer: ["admin"],
  });

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
      tabs={[
        { label: "Registry", href: "/mcp-catalog/registry" },
        {
          label: "Installation Requests",
          href: "/mcp-catalog/installation-requests",
        },
      ]}
    >
      {children}
    </PageLayout>
  );
}
