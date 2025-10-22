"use client";

import Divider from "@/components/divider";
import type {
  GetMcpCatalogResponses,
  GetMcpServersResponses,
} from "@/lib/clients/api";
import ExternalMCPRegistry from "./_parts/ExternalMCPRegistry";
import { InternalMCPRegistry } from "./_parts/InternalMCPRegistry";

export default function McpRegistryPage({
  initialData,
}: {
  initialData: {
    catalog: GetMcpCatalogResponses["200"];
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
            Manage your Model Context Protocol (MCP) server catalog and
            installed server registry.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <InternalMCPRegistry
          initialData={initialData.catalog}
          installedServers={initialData.servers}
        />
        <Divider className="my-8" />
        <ExternalMCPRegistry catalogItems={initialData.catalog} />
      </div>
    </div>
  );
}
