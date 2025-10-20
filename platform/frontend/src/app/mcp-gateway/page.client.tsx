"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  GetMcpCatalogResponses,
  GetMcpServersResponses,
} from "@/lib/clients/api";
import { useMcpCatalog } from "@/lib/mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp-server.query";

function CatalogTab({
  initialData,
}: {
  initialData?: GetMcpCatalogResponses["200"];
}) {
  const { data: catalogItems } = useMcpCatalog({ initialData });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {catalogItems?.map((item) => (
          <div key={item.id} className="rounded-lg border p-4 space-y-2">
            <h3 className="font-medium">{item.name}</h3>
            <p className="text-sm text-muted-foreground">
              Created: {new Date(item.createdAt).toLocaleDateString()}
            </p>
          </div>
        ))}
      </div>
      {catalogItems?.length === 0 && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">No catalog items found.</p>
        </div>
      )}
    </div>
  );
}

function InstalledTab({
  initialData,
}: {
  initialData?: GetMcpServersResponses["200"];
}) {
  const { data: servers } = useMcpServers({ initialData });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {servers?.map((server) => (
          <div key={server.id} className="rounded-lg border p-4 space-y-2">
            <h3 className="font-medium">{server.name}</h3>
            <p className="text-sm text-muted-foreground">
              {server.catalogId ? "From catalog" : "Custom server"}
            </p>
            <p className="text-sm text-muted-foreground">
              Installed: {new Date(server.createdAt).toLocaleDateString()}
            </p>
          </div>
        ))}
      </div>
      {servers?.length === 0 && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">No servers installed.</p>
        </div>
      )}
    </div>
  );
}

export default function McpGatewayPage({
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
            MCP Gateway
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage Model Context Protocol servers and catalog.
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
            <CatalogTab initialData={initialData.catalog} />
          </TabsContent>
          <TabsContent value="installed">
            <InstalledTab initialData={initialData.servers} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
