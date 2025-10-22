"use client";

import Divider from "@/components/divider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  GetMcpCatalogResponses,
  GetMcpServersResponses,
} from "@/lib/clients/api";
import ExternalMCPRegistry from "./_parts/ExternalMCPRegistry";
import { InstalledMCP } from "./_parts/InstalledMCP";
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
        <Tabs defaultValue="catalog" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="catalog">Catalog</TabsTrigger>
            <TabsTrigger value="installed">Installed</TabsTrigger>
          </TabsList>
          <TabsContent value="catalog">
            <InternalMCPRegistry
              initialData={initialData.catalog}
              installedServers={initialData.servers}
            />
            <Divider className="my-8" />
            <ExternalMCPRegistry catalogItems={initialData.catalog} />
          </TabsContent>
          <TabsContent value="installed">
            <InstalledMCP initialData={initialData.servers} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
