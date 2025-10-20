"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMcpCatalog } from "@/lib/mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp-server.query";

function CatalogTab() {
  const { data: catalogItems } = useMcpCatalog();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">MCP Catalog</h2>
      </div>
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

function InstalledTab() {
  const { data: servers } = useMcpServers();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Installed MCP Servers</h2>
      </div>
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

export default function McpGatewayPage() {
  return (
    <div className="container mx-auto py-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">MCP Gateway</h1>
        <p className="text-muted-foreground mt-2">
          Manage Model Context Protocol servers and catalog.
        </p>
      </div>

      <Tabs defaultValue="catalog" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="installed">Installed</TabsTrigger>
        </TabsList>
        <TabsContent value="catalog">
          <CatalogTab />
        </TabsContent>
        <TabsContent value="installed">
          <InstalledTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
