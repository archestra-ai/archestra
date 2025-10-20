"use client";

import {
  Download,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  GetMcpCatalogResponses,
  GetMcpServersResponses,
} from "@/lib/clients/api";
import {
  useCreateMcpCatalogItem,
  useDeleteMcpCatalogItem,
  useMcpCatalog,
  useUpdateMcpCatalogItem,
} from "@/lib/mcp-catalog.query";
import {
  useDeleteMcpServer,
  useInstallMcpServer,
  useMcpServers,
} from "@/lib/mcp-server.query";

function CatalogTab({
  initialData,
  installedServers,
}: {
  initialData?: GetMcpCatalogResponses["200"];
  installedServers?: GetMcpServersResponses["200"];
}) {
  const { data: catalogItems } = useMcpCatalog({ initialData });
  const installMutation = useInstallMcpServer();
  const createMutation = useCreateMcpCatalogItem();
  const updateMutation = useUpdateMcpCatalogItem();
  const deleteMutation = useDeleteMcpCatalogItem();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<
    GetMcpCatalogResponses["200"][number] | null
  >(null);
  const [deletingItem, setDeletingItem] = useState<
    GetMcpCatalogResponses["200"][number] | null
  >(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [newItemName, setNewItemName] = useState("");
  const [editItemName, setEditItemName] = useState("");
  const [catalogSearchQuery, setCatalogSearchQuery] = useState("");

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

  const handleCreate = useCallback(async () => {
    try {
      await createMutation.mutateAsync({ name: newItemName });
      toast.success("Catalog item created successfully");
      setIsCreateDialogOpen(false);
      setNewItemName("");
    } catch (error) {
      toast.error("Failed to create catalog item");
      console.error("Create error:", error);
    }
  }, [createMutation, newItemName]);

  const handleEdit = useCallback(async () => {
    if (!editingItem) return;
    try {
      await updateMutation.mutateAsync({
        id: editingItem.id,
        data: { name: editItemName },
      });
      toast.success("Catalog item updated successfully");
      setEditingItem(null);
      setEditItemName("");
    } catch (error) {
      toast.error("Failed to update catalog item");
      console.error("Edit error:", error);
    }
  }, [updateMutation, editingItem, editItemName]);

  const handleDelete = useCallback(async () => {
    if (!deletingItem || deleteConfirmation !== "DELETE") return;

    try {
      await deleteMutation.mutateAsync(deletingItem.id);
      toast.success("Catalog item deleted successfully");
      setDeletingItem(null);
      setDeleteConfirmation("");
    } catch (error) {
      toast.error("Failed to delete catalog item");
      console.error("Delete error:", error);
    }
  }, [deleteMutation, deletingItem, deleteConfirmation]);

  const getInstallationCount = useCallback(
    (catalogId: string) => {
      return (
        installedServers?.filter((server) => server.catalogId === catalogId)
          .length || 0
      );
    },
    [installedServers],
  );

  const filteredCatalogItems = useMemo(() => {
    if (!catalogSearchQuery.trim()) return catalogItems || [];
    return (catalogItems || []).filter((item) =>
      item.name.toLowerCase().includes(catalogSearchQuery.toLowerCase()),
    );
  }, [catalogItems, catalogSearchQuery]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">MCP Catalog</h2>
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add to Catalog
        </Button>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search catalog items..."
          value={catalogSearchQuery}
          onChange={(e) => setCatalogSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filteredCatalogItems?.map((item) => (
          <div key={item.id} className="rounded-lg border p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-medium">{item.name}</h3>
                <p className="text-sm text-muted-foreground">
                  Created: {new Date(item.createdAt).toLocaleDateString()}
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => {
                      setEditingItem(item);
                      setEditItemName(item.name);
                    }}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setDeletingItem(item)}
                    className="text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
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

      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create New Catalog Item</DialogTitle>
            <DialogDescription>
              Add a new MCP server to the catalog.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                placeholder="Enter server name"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsCreateDialogOpen(false);
                setNewItemName("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!newItemName.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editingItem}
        onOpenChange={() => {
          setEditingItem(null);
          setEditItemName("");
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Catalog Item</DialogTitle>
            <DialogDescription>Update the catalog item name.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={editItemName}
                onChange={(e) => setEditItemName(e.target.value)}
                placeholder="Enter server name"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditingItem(null);
                setEditItemName("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleEdit}
              disabled={!editItemName.trim() || updateMutation.isPending}
            >
              {updateMutation.isPending ? "Updating..." : "Update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deletingItem}
        onOpenChange={() => {
          setDeletingItem(null);
          setDeleteConfirmation("");
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Delete Catalog Item</DialogTitle>
            <DialogDescription>
              {deletingItem &&
                (() => {
                  const installCount = getInstallationCount(deletingItem.id);
                  return installCount > 0 ? (
                    <span>
                      Are you sure you want to delete "{deletingItem.name}"?
                      There are currently <strong>{installCount}</strong>{" "}
                      installation(s) of this server. Deleting this catalog
                      entry will also uninstall all associated servers.
                    </span>
                  ) : (
                    `Are you sure you want to delete "${deletingItem.name}"? This action cannot be undone.`
                  );
                })()}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="delete-confirm">Type "DELETE" to confirm:</Label>
              <Input
                id="delete-confirm"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
                placeholder="DELETE"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeletingItem(null);
                setDeleteConfirmation("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={
                deleteConfirmation !== "DELETE" || deleteMutation.isPending
              }
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  const [serverSearchQuery, setServerSearchQuery] = useState("");

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

  const filteredServers = useMemo(() => {
    if (!serverSearchQuery.trim()) return servers || [];
    return (servers || []).filter((server) =>
      server.name.toLowerCase().includes(serverSearchQuery.toLowerCase()),
    );
  }, [servers, serverSearchQuery]);

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search installed servers..."
          value={serverSearchQuery}
          onChange={(e) => setServerSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filteredServers?.map((server) => (
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
      {filteredServers?.length === 0 && serverSearchQuery && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">
            No installed servers match "{serverSearchQuery}".
          </p>
        </div>
      )}
      {servers?.length === 0 && !serverSearchQuery && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">No servers installed.</p>
        </div>
      )}
    </div>
  );
}

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
            <CatalogTab
              initialData={initialData.catalog}
              installedServers={initialData.servers}
            />
          </TabsContent>
          <TabsContent value="installed">
            <InstalledTab initialData={initialData.servers} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
