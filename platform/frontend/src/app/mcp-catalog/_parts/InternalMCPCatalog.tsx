"use client";

import { GITHUB_MCP_SERVER_NAME } from "@shared";
import {
  Download,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type {
  GetInternalMcpCatalogResponses,
  GetMcpServersResponses,
} from "@/lib/clients/api";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import { useInstallMcpServer, useMcpServers } from "@/lib/mcp-server.query";
import { formatDate } from "@/lib/utils";
import { CreateCatalogDialog } from "./create-catalog-dialog";
import { DeleteCatalogDialog } from "./delete-catalog-dialog";
import { EditCatalogDialog } from "./edit-catalog-dialog";
import { GitHubInstallDialog } from "./github-install-dialog";
import { UninstallServerDialog } from "./uninstall-server-dialog";

export function InternalMCPCatalog({
  initialData,
  installedServers: initialInstalledServers,
}: {
  initialData?: GetInternalMcpCatalogResponses["200"];
  installedServers?: GetMcpServersResponses["200"];
}) {
  const { data: catalogItems } = useInternalMcpCatalog({ initialData });
  const { data: installedServers } = useMcpServers({
    initialData: initialInstalledServers,
  });
  const installMutation = useInstallMcpServer();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<
    GetInternalMcpCatalogResponses["200"][number] | null
  >(null);
  const [deletingItem, setDeletingItem] = useState<
    GetInternalMcpCatalogResponses["200"][number] | null
  >(null);
  const [uninstallingServer, setUninstallingServer] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [installingItemId, setInstallingItemId] = useState<string | null>(null);
  const [catalogSearchQuery, setCatalogSearchQuery] = useState("");
  const [isGitHubDialogOpen, setIsGitHubDialogOpen] = useState(false);
  const [selectedCatalogItem, setSelectedCatalogItem] = useState<
    GetInternalMcpCatalogResponses["200"][number] | null
  >(null);

  const handleInstall = useCallback(
    async (catalogItem: GetInternalMcpCatalogResponses["200"][number]) => {
      /**
       * NOTE: THIS IS ABSOLUTELY TEMPORARY..
       *
       * Check if this is a GitHub MCP server that requires authentication
       */
      if (catalogItem.name === GITHUB_MCP_SERVER_NAME) {
        setSelectedCatalogItem(catalogItem);
        setIsGitHubDialogOpen(true);
        return;
      }

      // For other servers, install directly
      setInstallingItemId(catalogItem.id);
      await installMutation.mutateAsync({
        name: catalogItem.name,
        catalogId: catalogItem.id,
      });
      setInstallingItemId(null);
    },
    [installMutation],
  );

  const handleGitHubInstall = useCallback(
    async (
      catalogItem: GetInternalMcpCatalogResponses["200"][number],
      metadata: Record<string, unknown>,
    ) => {
      setInstallingItemId(catalogItem.id);
      await installMutation.mutateAsync({
        name: catalogItem.name,
        catalogId: catalogItem.id,
        metadata,
      });
      setInstallingItemId(null);
    },
    [installMutation],
  );

  const getInstallationCount = useCallback(
    (catalogId: string) => {
      return (
        installedServers?.filter((server) => server.catalogId === catalogId)
          .length || 0
      );
    },
    [installedServers],
  );

  const getInstalledServer = useCallback(
    (catalogId: string) => {
      return installedServers?.find((server) => server.catalogId === catalogId);
    },
    [installedServers],
  );

  const handleUninstallClick = useCallback(
    (serverId: string, serverName: string) => {
      setUninstallingServer({ id: serverId, name: serverName });
    },
    [],
  );

  const filteredCatalogItems = useMemo(() => {
    const items = catalogSearchQuery.trim()
      ? (catalogItems || []).filter((item) =>
          item.name.toLowerCase().includes(catalogSearchQuery.toLowerCase()),
        )
      : catalogItems || [];

    // Sort: installed servers first
    return items.sort((a, b) => {
      const aInstalled = installedServers?.some(
        (server) => server.catalogId === a.id,
      );
      const bInstalled = installedServers?.some(
        (server) => server.catalogId === b.id,
      );

      if (aInstalled && !bInstalled) return -1;
      if (!aInstalled && bInstalled) return 1;
      return 0;
    });
  }, [catalogItems, catalogSearchQuery, installedServers]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Private MCP Registry</h2>
          <p className="text-sm text-muted-foreground">
            MCP Servers from this registry can be assigned to your agents.
          </p>
        </div>
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add MCP server using config
        </Button>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search servers by name..."
          value={catalogSearchQuery}
          onChange={(e) => setCatalogSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filteredCatalogItems?.map((item) => {
          const installedServer = getInstalledServer(item.id);

          return (
            <div key={item.id} className="rounded-lg border p-4 flex flex-col">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-h-[3rem]">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-medium">{item.name}</h3>
                    {item.version && (
                      <Badge variant="secondary" className="text-xs">
                        v{item.version}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Created:{" "}
                    {formatDate({
                      date: item.createdAt,
                      dateFormat: "MM/dd/yyyy",
                    })}
                  </p>
                  {installedServer && (
                    <p className="text-sm text-muted-foreground">
                      Installed:{" "}
                      {formatDate({
                        date: installedServer.createdAt,
                        dateFormat: "MM/dd/yyyy",
                      })}
                    </p>
                  )}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setEditingItem(item)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDeletingItem(item)}>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="mt-auto">
                {installedServer ? (
                  <Button
                    onClick={() =>
                      handleUninstallClick(
                        installedServer.id,
                        installedServer.name,
                      )
                    }
                    size="sm"
                    className="w-full bg-accent text-accent-foreground hover:bg-accent"
                  >
                    Uninstall
                  </Button>
                ) : (
                  <Button
                    onClick={() => handleInstall(item)}
                    disabled={installingItemId === item.id}
                    size="sm"
                    className="w-full"
                  >
                    <Download className="mr-2 h-4 w-4" />
                    {installingItemId === item.id ? "Installing..." : "Install"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {filteredCatalogItems?.length === 0 && catalogSearchQuery && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">
            No catalog items match "{catalogSearchQuery}".
          </p>
        </div>
      )}
      {catalogItems?.length === 0 && !catalogSearchQuery && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">No catalog items found.</p>
        </div>
      )}

      <CreateCatalogDialog
        isOpen={isCreateDialogOpen}
        onClose={() => setIsCreateDialogOpen(false)}
      />

      <EditCatalogDialog
        item={editingItem}
        onClose={() => setEditingItem(null)}
      />

      <DeleteCatalogDialog
        item={deletingItem}
        onClose={() => setDeletingItem(null)}
        installationCount={
          deletingItem ? getInstallationCount(deletingItem.id) : 0
        }
      />

      <GitHubInstallDialog
        isOpen={isGitHubDialogOpen}
        onClose={() => {
          setIsGitHubDialogOpen(false);
          setSelectedCatalogItem(null);
        }}
        onInstall={handleGitHubInstall}
        catalogItem={selectedCatalogItem}
        isInstalling={installMutation.isPending}
      />

      <UninstallServerDialog
        server={uninstallingServer}
        onClose={() => setUninstallingServer(null)}
      />
    </div>
  );
}
