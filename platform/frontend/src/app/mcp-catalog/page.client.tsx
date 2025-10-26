"use client";

import Divider from "@/components/divider";
import type {
  GetInternalMcpCatalogResponses,
  GetMcpServersResponses,
} from "@/lib/clients/api";
import { ExternalMCPCatalog } from "./_parts/ExternalMCPCatalog";
import { InternalMCPCatalog } from "./_parts/InternalMCPCatalog";

export default function McpRegistryPage({
  initialData,
}: {
  initialData: {
    catalog: GetInternalMcpCatalogResponses["200"];
    servers: GetMcpServersResponses["200"];
  };
}) {
  return (
    <div className="w-full h-full">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">
            MCP Registry
          </h1>
          <p className="text-sm text-muted-foreground">
            Self-hosted MCP registry allows you to manage your own list of MCP
            servers and make them available to your agents.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <InternalMCPCatalog
          initialData={initialData.catalog}
          installedServers={initialData.servers}
        />
        <Divider className="my-8" />
        <ExternalMCPCatalog catalogItems={initialData.catalog} />
      </div>
    </div>
  );
}
