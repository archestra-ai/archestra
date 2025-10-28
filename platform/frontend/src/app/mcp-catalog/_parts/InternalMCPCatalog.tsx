"use client";

import {
  Download,
  Eye,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { AssignAgentDialog } from "@/app/tools/_parts/assign-agent-dialog";
import { OAuthConfirmationDialog } from "@/components/oauth-confirmation-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  useDeleteMcpServer,
  useInstallMcpServer,
  useMcpServers,
  useMcpServerTools,
} from "@/lib/mcp-server.query";
import { BulkAssignAgentDialog } from "./bulk-assign-agent-dialog";
import { CreateCatalogDialog } from "./create-catalog-dialog";
import { DeleteCatalogDialog } from "./delete-catalog-dialog";
import { EditCatalogDialog } from "./edit-catalog-dialog";
import { McpToolsDialog } from "./mcp-tools-dialog";
import { ReinstallConfirmationDialog } from "./reinstall-confirmation-dialog";
import { RemoteServerInstallDialog } from "./remote-server-install-dialog";
import { TransportBadges } from "./transport-badges";
import { UninstallServerDialog } from "./uninstall-server-dialog";

type CatalogItemWithOptionalLabel =
  GetInternalMcpCatalogResponses["200"][number] & {
    label?: string | null;
  };

function InternalServerCard({
  item,
  installed,
  isInstalling,
  needsReinstall,
  onInstall,
  onUninstall,
  onReinstall,
  onEdit,
  onDelete,
  onViewTools,
}: {
  item: CatalogItemWithOptionalLabel;
  installed: boolean;
  isInstalling: boolean;
  needsReinstall: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onReinstall: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onViewTools?: () => void;
}) {
  return (
    <Card className="flex flex-col relative pt-4">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <CardTitle className="text-lg truncate mb-1 flex items-center">
              {item.label || item.name}
            </CardTitle>
            {item.label && item.label !== item.name && (
              <p className="text-xs text-muted-foreground font-mono truncate mb-2">
                {item.name}
              </p>
            )}
            <div className="flex items-center gap-2">
              {item.oauthConfig && (
                <Badge variant="secondary" className="text-xs">
                  OAuth
                </Badge>
              )}
              <TransportBadges isRemote={item.serverType === "remote"} />
            </div>
          </div>
          <div className="flex flex-wrap gap-1 items-center flex-shrink-0 mt-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 right-2"
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onDelete}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col pt-3 gap-2 justify-end">
        {installed ? (
          <>
            {needsReinstall && (
              <Button
                onClick={onReinstall}
                size="sm"
                variant="default"
                className="w-full"
                disabled={isInstalling}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {isInstalling ? "Reinstalling..." : "Reinstall Required"}
              </Button>
            )}
            {onViewTools && (
              <Button
                onClick={onViewTools}
                size="sm"
                variant="outline"
                className="w-full"
              >
                <Eye className="mr-2 h-4 w-4" />
                View Tools
              </Button>
            )}
            <Button
              onClick={onUninstall}
              size="sm"
              className="w-full bg-accent text-accent-foreground hover:bg-accent"
            >
              Uninstall
            </Button>
          </>
        ) : (
          <Button
            onClick={onInstall}
            disabled={isInstalling}
            size="sm"
            className="w-full"
          >
            <Download className="mr-2 h-4 w-4" />
            {isInstalling ? "Installing..." : "Install"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

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
  const deleteMutation = useDeleteMcpServer();

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
  const [isRemoteServerDialogOpen, setIsRemoteServerDialogOpen] =
    useState(false);
  const [selectedCatalogItem, setSelectedCatalogItem] = useState<
    GetInternalMcpCatalogResponses["200"][number] | null
  >(null);
  const [isOAuthDialogOpen, setIsOAuthDialogOpen] = useState(false);
  const [toolsDialogServerId, setToolsDialogServerId] = useState<string | null>(
    null,
  );
  const [toolsDialogKey, setToolsDialogKey] = useState(0);
  const [selectedToolForAssignment, setSelectedToolForAssignment] = useState<{
    id: string;
    name: string;
    description: string | null;
    parameters: Record<string, unknown>;
    createdAt: string;
    mcpServerId: string | null;
    mcpServerName: string | null;
  } | null>(null);
  const [bulkAssignTools, setBulkAssignTools] = useState<
    Array<{
      id: string;
      name: string;
      description: string | null;
      parameters: Record<string, unknown>;
      createdAt: string;
    }>
  >([]);
  const [showReinstallDialog, setShowReinstallDialog] = useState(false);
  const [catalogItemForReinstall, setCatalogItemForReinstall] = useState<
    GetInternalMcpCatalogResponses["200"][number] | null
  >(null);

  const toolsDialogServer = useMemo(() => {
    return installedServers?.find(
      (server) => server.id === toolsDialogServerId,
    );
  }, [installedServers, toolsDialogServerId]);

  const { data: toolsDialogTools, isLoading: isLoadingToolsDialogTools } =
    useMcpServerTools(toolsDialogServerId);

  const handleInstall = useCallback(
    async (catalogItem: GetInternalMcpCatalogResponses["200"][number]) => {
      // Check if this is a remote server with user configuration or it's the GitHub MCP server from the external catalog
      if (
        catalogItem.serverType === "remote" &&
        catalogItem.userConfig &&
        Object.keys(catalogItem.userConfig).length > 0
      ) {
        setSelectedCatalogItem(catalogItem);
        setIsRemoteServerDialogOpen(true);
        return;
      }

      // Check if this server requires OAuth authentication
      if (catalogItem.oauthConfig) {
        setSelectedCatalogItem(catalogItem);
        setIsOAuthDialogOpen(true);
        return;
      }

      // For servers without configuration, install directly
      try {
        setInstallingItemId(catalogItem.id);
        await installMutation.mutateAsync({
          name: catalogItem.name,
          catalogId: catalogItem.id,
          teams: [],
        });
      } finally {
        setInstallingItemId(null);
      }
    },
    [installMutation],
  );

  const handleGitHubInstall = useCallback(
    async (
      catalogItem: GetInternalMcpCatalogResponses["200"][number],
      accessToken: string,
      teams: string[],
    ) => {
      try {
        setInstallingItemId(catalogItem.id);
        await installMutation.mutateAsync({
          name: catalogItem.name,
          catalogId: catalogItem.id,
          accessToken,
          teams,
        });
      } finally {
        setInstallingItemId(null);
      }
    },
    [installMutation],
  );

  const handleRemoteServerInstall = useCallback(
    async (
      catalogItem: GetInternalMcpCatalogResponses["200"][number],
      metadata?: Record<string, unknown>,
    ) => {
      try {
        setInstallingItemId(catalogItem.id);

        // Extract access_token from metadata if present and pass as accessToken
        const accessToken =
          metadata?.access_token && typeof metadata.access_token === "string"
            ? metadata.access_token
            : undefined;

        await installMutation.mutateAsync({
          name: catalogItem.name,
          catalogId: catalogItem.id,
          ...(accessToken && { accessToken }),
        });
      } finally {
        setInstallingItemId(null);
      }
    },
    [installMutation],
  );

  const handleOAuthConfirm = useCallback(async () => {
    if (!selectedCatalogItem) return;

    try {
      // Call backend to initiate OAuth flow
      const response = await fetch("/api/oauth/initiate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          catalogId: selectedCatalogItem.id,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to initiate OAuth flow");
      }

      const { authorizationUrl, state } = await response.json();

      // Store state in session storage for the callback
      sessionStorage.setItem("oauth_state", state);
      sessionStorage.setItem("oauth_catalog_id", selectedCatalogItem.id);

      // Redirect to OAuth provider
      window.location.href = authorizationUrl;
    } catch {
      // TODO: Show error toast
    }
  }, [selectedCatalogItem]);

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

  const handleReinstallRequired = useCallback(
    async (
      catalogId: string,
      updatedData?: { name?: string; serverUrl?: string },
    ) => {
      // Check if there's an installed server from this catalog item
      const installedServer = getInstalledServer(catalogId);

      // Only show reinstall dialog if the server is actually installed
      if (!installedServer) {
        return;
      }

      // Wait a bit for queries to refetch after mutation
      // This ensures we have fresh catalog data
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Find the catalog item and show reinstall dialog
      let catalogItem = catalogItems?.find((item) => item.id === catalogId);

      // If we have updated data from the edit, merge it with the catalog item
      if (catalogItem && updatedData) {
        catalogItem = {
          ...catalogItem,
          ...(updatedData.name && { name: updatedData.name }),
          ...(updatedData.serverUrl && { serverUrl: updatedData.serverUrl }),
        };
      }

      if (catalogItem) {
        setCatalogItemForReinstall(catalogItem);
        setShowReinstallDialog(true);
      }
    },
    [catalogItems, getInstalledServer],
  );

  const handleReinstall = useCallback(
    async (catalogItem: GetInternalMcpCatalogResponses["200"][number]) => {
      // Get the installed server to get its ID (not catalog ID)
      const installedServer = installedServers?.find(
        (server) => server.catalogId === catalogItem.id,
      );
      if (!installedServer) {
        toast.error("Server not found, cannot reinstall");
        return;
      }

      // Delete the installed server using its server ID
      await deleteMutation.mutateAsync({
        id: installedServer.id,
        name: catalogItem.name,
      });

      // Then reinstall
      await handleInstall(catalogItem);
    },
    [handleInstall, deleteMutation, installedServers],
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
          const itemWithLabel = item as CatalogItemWithOptionalLabel;

          return (
            <InternalServerCard
              key={item.id}
              item={itemWithLabel}
              installed={!!installedServer}
              isInstalling={
                installingItemId === item.id || installMutation.isPending
              }
              needsReinstall={installedServer?.reinstallRequired ?? false}
              onInstall={() => handleInstall(item)}
              onUninstall={() => {
                if (installedServer) {
                  handleUninstallClick(
                    installedServer.id,
                    installedServer.name,
                  );
                }
              }}
              onReinstall={() => handleReinstall(item)}
              onEdit={() => setEditingItem(item)}
              onDelete={() => setDeletingItem(item)}
              onViewTools={
                installedServer
                  ? () => setToolsDialogServerId(installedServer.id)
                  : undefined
              }
            />
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
        onReinstallRequired={handleReinstallRequired}
      />

      <DeleteCatalogDialog
        item={deletingItem}
        onClose={() => setDeletingItem(null)}
        installationCount={
          deletingItem ? getInstallationCount(deletingItem.id) : 0
        }
      />

      <RemoteServerInstallDialog
        isOpen={isRemoteServerDialogOpen}
        onClose={() => {
          setIsRemoteServerDialogOpen(false);
          setSelectedCatalogItem(null);
        }}
        onInstall={handleRemoteServerInstall}
        catalogItem={selectedCatalogItem}
        isInstalling={installMutation.isPending}
      />

      <OAuthConfirmationDialog
        open={isOAuthDialogOpen}
        onOpenChange={setIsOAuthDialogOpen}
        serverName={selectedCatalogItem?.name || ""}
        onConfirm={handleOAuthConfirm}
        onCancel={() => {
          setIsOAuthDialogOpen(false);
          setSelectedCatalogItem(null);
        }}
      />

      <UninstallServerDialog
        server={uninstallingServer}
        onClose={() => setUninstallingServer(null)}
      />

      <McpToolsDialog
        key={toolsDialogKey}
        open={!!toolsDialogServerId}
        onOpenChange={(open) => {
          if (!open) setToolsDialogServerId(null);
        }}
        serverName={toolsDialogServer?.name ?? ""}
        tools={toolsDialogTools ?? []}
        isLoading={isLoadingToolsDialogTools}
        onAssignTool={(tool) => {
          setSelectedToolForAssignment({
            ...tool,
            mcpServerId: toolsDialogServerId,
            mcpServerName: toolsDialogServer?.name ?? null,
          });
        }}
        onBulkAssignTools={(tools) => {
          setBulkAssignTools(tools);
        }}
      />

      <BulkAssignAgentDialog
        tools={bulkAssignTools.length > 0 ? bulkAssignTools : null}
        open={bulkAssignTools.length > 0}
        onOpenChange={(open) => {
          if (!open) {
            setBulkAssignTools([]);
            // Reset the tools dialog to clear selections
            setToolsDialogKey((prev) => prev + 1);
          }
        }}
      />

      <AssignAgentDialog
        tool={
          selectedToolForAssignment
            ? {
                id: selectedToolForAssignment.id,
                tool: {
                  id: selectedToolForAssignment.id,
                  name: selectedToolForAssignment.name,
                  description: selectedToolForAssignment.description,
                  parameters: selectedToolForAssignment.parameters,
                  createdAt: selectedToolForAssignment.createdAt,
                  updatedAt: selectedToolForAssignment.createdAt,
                  mcpServerId: selectedToolForAssignment.mcpServerId,
                  mcpServerName: selectedToolForAssignment.mcpServerName,
                },
                agent: null,
                createdAt: selectedToolForAssignment.createdAt,
                updatedAt: selectedToolForAssignment.createdAt,
              }
            : null
        }
        open={!!selectedToolForAssignment}
        onOpenChange={(open) => {
          if (!open) setSelectedToolForAssignment(null);
        }}
      />

      <ReinstallConfirmationDialog
        isOpen={showReinstallDialog}
        onClose={() => {
          setShowReinstallDialog(false);
          setCatalogItemForReinstall(null);
        }}
        onConfirm={async () => {
          if (catalogItemForReinstall) {
            setShowReinstallDialog(false);
            await handleReinstall(catalogItemForReinstall);
            setCatalogItemForReinstall(null);
          }
        }}
        serverName={
          catalogItemForReinstall?.label || catalogItemForReinstall?.name || ""
        }
        isReinstalling={installMutation.isPending}
      />
    </div>
  );
}
