"use client";

import { Download, Trash2 } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  GetMcpCatalogResponses,
  GetMcpServersResponses,
} from "@/lib/clients/api";
import { useMcpCatalog } from "@/lib/mcp-catalog.query";
import {
  useDeleteMcpServer,
  useInstallMcpServer,
  useMcpServers,
} from "@/lib/mcp-server.query";

function CatalogTab({
  initialData,
}: {
  initialData?: GetMcpCatalogResponses["200"];
}) {
  const { data: catalogItems } = useMcpCatalog({ initialData });
  const installMutation = useInstallMcpServer();

  const handleInstall = useCallback(
    async (catalogItem: GetMcpCatalogResponses["200"][number]) => {
      try {
        await installMutation.mutateAsync({
          name: catalogItem.name,
          catalogId: catalogItem.id,
        });
        toast.success(`Successfully installed ${catalogItem.name}`);
      } catch (error) {
        toast.error(`Failed to install ${catalogItem.name}`);
        console.error("Install error:", error);
      }
    },
    [installMutation],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {catalogItems?.map((item) => (
          <div key={item.id} className="rounded-lg border p-4 space-y-3">
            <div>
              <h3 className="font-medium">{item.name}</h3>
              <p className="text-sm text-muted-foreground">
                Created: {new Date(item.createdAt).toLocaleDateString()}
              </p>
            </div>
            <Button
              onClick={() => handleInstall(item)}
              disabled={installMutation.isPending}
              size="sm"
              className="w-full"
            >
              <Download className="mr-2 h-4 w-4" />
              {installMutation.isPending ? "Installing..." : "Install"}
            </Button>
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
  const deleteMutation = useDeleteMcpServer();

  const handleDelete = useCallback(
    async (server: GetMcpServersResponses["200"][number]) => {
      try {
        await deleteMutation.mutateAsync(server.id);
        toast.success(`Successfully uninstalled ${server.name}`);
      } catch (error) {
        toast.error(`Failed to uninstall ${server.name}`);
        console.error("Delete error:", error);
      }
    },
    [deleteMutation],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {servers?.map((server) => (
          <div key={server.id} className="rounded-lg border p-4 space-y-3">
            <div>
              <h3 className="font-medium">{server.name}</h3>
              <p className="text-sm text-muted-foreground">
                {server.catalogId ? "From catalog" : "Custom server"}
              </p>
              <p className="text-sm text-muted-foreground">
                Installed: {new Date(server.createdAt).toLocaleDateString()}
              </p>
            </div>
            <Button
              onClick={() => handleDelete(server)}
              disabled={deleteMutation.isPending}
              size="sm"
              variant="destructive"
              className="w-full"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {deleteMutation.isPending ? "Uninstalling..." : "Uninstall"}
            </Button>
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
