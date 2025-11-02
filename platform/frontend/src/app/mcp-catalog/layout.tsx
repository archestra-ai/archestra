"use client";

import { PageLayout } from "@/components/page-layout";
import { useRole } from "@/lib/auth.hook";

export default function McpCatalogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const a = useRole();
  return (
    <PageLayout
      title="MCP Catalog"
      description={
        <>
          <p>
            Self-hosted MCP registry allows you to manage your own list of MCP
            servers and make them available to your agents.
          </p>
          <p>
            You can also{" "}
            {a === "admin"
              ? "review and manage installation requests from your team members"
              : "view your installation requests and their status"}
          </p>
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
