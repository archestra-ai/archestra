"use client";

import { type archestraApiTypes, E2eTestId } from "@shared";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import {
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  Star,
  StarOff,
  Trash2,
  Users,
} from "lucide-react";
import Image from "next/image";
import { Suspense, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  PROVIDER_CONFIG,
  type SupportedChatProvider,
} from "@/components/chat/create-chat-api-key-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfiles } from "@/lib/agent.query";
import {
  useBulkAssignChatApiKeysToProfiles,
  useChatApiKeys,
  useCreateChatApiKey,
  useDeleteChatApiKey,
  useSetChatApiKeyDefault,
  useUnsetChatApiKeyDefault,
  useUpdateChatApiKey,
  useUpdateChatApiKeyProfiles,
} from "@/lib/chat-settings.query";

type ChatApiKey = archestraApiTypes.GetChatApiKeysResponses["200"][number];

function ChatSettingsContent() {
  const { data: apiKeys = [] } = useChatApiKeys();
  const { data: allProfiles = [] } = useProfiles();
  const createApiKeyMutation = useCreateChatApiKey();
  const updateApiKeyMutation = useUpdateChatApiKey();
  const deleteApiKeyMutation = useDeleteChatApiKey();
  const setDefaultMutation = useSetChatApiKeyDefault();
  const unsetDefaultMutation = useUnsetChatApiKeyDefault();
  const updateProfilesMutation = useUpdateChatApiKeyProfiles();
  const bulkAssignMutation = useBulkAssignChatApiKeysToProfiles();

  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isProfilesDialogOpen, setIsProfilesDialogOpen] = useState(false);
  const [isBulkAssignDialogOpen, setIsBulkAssignDialogOpen] = useState(false);
  const [selectedApiKey, setSelectedApiKey] = useState<ChatApiKey | null>(null);

  // Row selection state
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  // Form states
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyProvider, setNewKeyProvider] =
    useState<SupportedChatProvider>("anthropic");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [newKeyIsDefault, setNewKeyIsDefault] = useState(false);
  const [editKeyName, setEditKeyName] = useState("");
  const [editKeyValue, setEditKeyValue] = useState("");
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [bulkAssignProfileIds, setBulkAssignProfileIds] = useState<string[]>(
    [],
  );

  // Compute selected API keys from row selection
  // Since we use getRowId, rowSelection keys are the actual API key IDs
  const selectedApiKeyIds = useMemo(() => {
    return Object.keys(rowSelection).filter((id) => rowSelection[id]);
  }, [rowSelection]);

  const hasSelection = selectedApiKeyIds.length > 0;

  const resetCreateForm = useCallback(() => {
    setNewKeyName("");
    setNewKeyProvider("anthropic");
    setNewKeyValue("");
    setNewKeyIsDefault(false);
  }, []);

  const handleCreate = useCallback(async () => {
    try {
      await createApiKeyMutation.mutateAsync({
        name: newKeyName,
        provider: newKeyProvider,
        apiKey: newKeyValue,
        isOrganizationDefault: newKeyIsDefault,
      });
      toast.success("API key created successfully");
      setIsCreateDialogOpen(false);
      resetCreateForm();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create API key";
      toast.error(message);
    }
  }, [
    createApiKeyMutation,
    newKeyName,
    newKeyProvider,
    newKeyValue,
    newKeyIsDefault,
    resetCreateForm,
  ]);

  const handleEdit = useCallback(async () => {
    if (!selectedApiKey) return;
    try {
      await updateApiKeyMutation.mutateAsync({
        id: selectedApiKey.id,
        data: {
          name: editKeyName || undefined,
          apiKey: editKeyValue || undefined,
        },
      });
      toast.success("API key updated successfully");
      setIsEditDialogOpen(false);
      setSelectedApiKey(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update API key";
      toast.error(message);
    }
  }, [selectedApiKey, updateApiKeyMutation, editKeyName, editKeyValue]);

  const handleDelete = useCallback(async () => {
    if (!selectedApiKey) return;
    try {
      await deleteApiKeyMutation.mutateAsync(selectedApiKey.id);
      toast.success("API key deleted successfully");
      setIsDeleteDialogOpen(false);
      setSelectedApiKey(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to delete API key";
      toast.error(message);
    }
  }, [selectedApiKey, deleteApiKeyMutation]);

  const handleSetDefault = useCallback(
    async (apiKey: ChatApiKey) => {
      try {
        await setDefaultMutation.mutateAsync(apiKey.id);
        toast.success("Set as organization default");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to set as default";
        toast.error(message);
      }
    },
    [setDefaultMutation],
  );

  const handleUnsetDefault = useCallback(
    async (apiKey: ChatApiKey) => {
      try {
        await unsetDefaultMutation.mutateAsync(apiKey.id);
        toast.success("Removed as organization default");
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to remove as default";
        toast.error(message);
      }
    },
    [unsetDefaultMutation],
  );

  const handleUpdateProfiles = useCallback(async () => {
    if (!selectedApiKey) return;
    try {
      await updateProfilesMutation.mutateAsync({
        id: selectedApiKey.id,
        profileIds: selectedProfileIds,
      });
      toast.success("Profile assignments updated");
      setIsProfilesDialogOpen(false);
      setSelectedApiKey(null);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to update profile assignments";
      toast.error(message);
    }
  }, [selectedApiKey, updateProfilesMutation, selectedProfileIds]);

  const handleBulkAssign = useCallback(async () => {
    if (selectedApiKeyIds.length === 0 || bulkAssignProfileIds.length === 0)
      return;
    try {
      await bulkAssignMutation.mutateAsync({
        chatApiKeyIds: selectedApiKeyIds,
        profileIds: bulkAssignProfileIds,
      });
      toast.success(
        `Assigned ${selectedApiKeyIds.length} API key(s) to ${bulkAssignProfileIds.length} profile(s)`,
      );
      setIsBulkAssignDialogOpen(false);
      setBulkAssignProfileIds([]);
      setRowSelection({});
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to bulk assign API keys";
      toast.error(message);
    }
  }, [selectedApiKeyIds, bulkAssignProfileIds, bulkAssignMutation]);

  const openBulkAssignDialog = useCallback(() => {
    setBulkAssignProfileIds([]);
    setIsBulkAssignDialogOpen(true);
  }, []);

  const clearSelection = useCallback(() => {
    setRowSelection({});
  }, []);

  const openEditDialog = useCallback((apiKey: ChatApiKey) => {
    setSelectedApiKey(apiKey);
    setEditKeyName(apiKey.name);
    setEditKeyValue("");
    setIsEditDialogOpen(true);
  }, []);

  const openDeleteDialog = useCallback((apiKey: ChatApiKey) => {
    setSelectedApiKey(apiKey);
    setIsDeleteDialogOpen(true);
  }, []);

  const openProfilesDialog = useCallback((apiKey: ChatApiKey) => {
    setSelectedApiKey(apiKey);
    setSelectedProfileIds(apiKey.profiles?.map((p) => p.id) || []);
    setIsProfilesDialogOpen(true);
  }, []);

  const columns: ColumnDef<ChatApiKey>[] = useMemo(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(value) =>
              table.toggleAllPageRowsSelected(!!value)
            }
            aria-label="Select all"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label={`Select ${row.original.name}`}
          />
        ),
        size: 30,
      },
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div
            className="flex items-center gap-2"
            data-testid={`${E2eTestId.ChatApiKeyRow}-${row.original.name}`}
          >
            <span className="font-medium">{row.original.name}</span>
            {row.original.isOrganizationDefault && (
              <Badge
                variant="secondary"
                className="text-xs"
                data-testid={`${E2eTestId.ChatApiKeyDefaultBadge}-${row.original.name}`}
              >
                <Star className="h-3 w-3 mr-1" />
                Default
              </Badge>
            )}
          </div>
        ),
      },
      {
        accessorKey: "provider",
        header: "Provider",
        cell: ({ row }) => {
          const config = PROVIDER_CONFIG[row.original.provider];
          return (
            <div className="flex items-center gap-2">
              <Image
                src={config.icon}
                alt={config.name}
                width={20}
                height={20}
                className="rounded"
              />
              <span>{config.name}</span>
            </div>
          );
        },
      },
      {
        accessorKey: "secretId",
        header: "Status",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            {row.original.secretId ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span className="text-sm text-muted-foreground">
                  Configured
                </span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                Not configured
              </span>
            )}
          </div>
        ),
      },
      {
        accessorKey: "profiles",
        header: "Profiles",
        cell: ({ row }) => {
          const profileCount = row.original.profiles?.length || 0;
          return (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-sm text-muted-foreground">
                    {profileCount}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {profileCount > 0 ? (
                    <div>
                      <p className="font-medium mb-1">Assigned to:</p>
                      <ul className="text-xs">
                        {row.original.profiles?.slice(0, 5).map((p) => (
                          <li key={p.id}>{p.name}</li>
                        ))}
                        {profileCount > 5 && (
                          <li>...and {profileCount - 5} more</li>
                        )}
                      </ul>
                    </div>
                  ) : (
                    "No profiles assigned"
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        },
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <ButtonGroup>
            <PermissionButton
              permissions={{ chatSettings: ["update"] }}
              tooltip="Edit"
              aria-label="Edit"
              variant="outline"
              size="icon-sm"
              data-testid={`${E2eTestId.EditChatApiKeyButton}-${row.original.name}`}
              onClick={(e) => {
                e.stopPropagation();
                openEditDialog(row.original);
              }}
            >
              <Pencil className="h-4 w-4" />
            </PermissionButton>
            <PermissionButton
              permissions={{ chatSettings: ["update"] }}
              tooltip="Manage Profiles"
              aria-label="Manage Profiles"
              variant="outline"
              size="icon-sm"
              data-testid={`${E2eTestId.ManageProfilesChatApiKeyButton}-${row.original.name}`}
              onClick={(e) => {
                e.stopPropagation();
                openProfilesDialog(row.original);
              }}
            >
              <Users className="h-4 w-4" />
            </PermissionButton>
            <PermissionButton
              permissions={{ chatSettings: ["update"] }}
              tooltip={
                row.original.isOrganizationDefault
                  ? "Remove as Default"
                  : "Set as Default"
              }
              aria-label={
                row.original.isOrganizationDefault
                  ? "Remove as Default"
                  : "Set as Default"
              }
              variant="outline"
              size="icon-sm"
              data-testid={`${E2eTestId.SetDefaultChatApiKeyButton}-${row.original.name}`}
              onClick={(e) => {
                e.stopPropagation();
                if (row.original.isOrganizationDefault) {
                  handleUnsetDefault(row.original);
                } else {
                  handleSetDefault(row.original);
                }
              }}
            >
              {row.original.isOrganizationDefault ? (
                <StarOff className="h-4 w-4" />
              ) : (
                <Star className="h-4 w-4" />
              )}
            </PermissionButton>
            <PermissionButton
              permissions={{ chatSettings: ["delete"] }}
              tooltip="Delete"
              aria-label="Delete"
              variant="outline"
              size="icon-sm"
              data-testid={`${E2eTestId.DeleteChatApiKeyButton}-${row.original.name}`}
              onClick={(e) => {
                e.stopPropagation();
                openDeleteDialog(row.original);
              }}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </PermissionButton>
          </ButtonGroup>
        ),
      },
    ],
    [
      openEditDialog,
      openDeleteDialog,
      openProfilesDialog,
      handleSetDefault,
      handleUnsetDefault,
    ],
  );

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">LLM Provider API Keys</h2>
          <p className="text-sm text-muted-foreground">
            Manage API keys for LLM providers used in the Archestra Chat
          </p>
        </div>
        <Button
          onClick={() => setIsCreateDialogOpen(true)}
          data-testid={E2eTestId.AddChatApiKeyButton}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add API Key
        </Button>
      </div>

      {/* Bulk Actions Bar */}
      {hasSelection && (
        <div className="flex items-center gap-4 rounded-md border bg-muted/50 p-3">
          <span className="text-sm font-medium">
            {selectedApiKeyIds.length} key(s) selected
          </span>
          <div className="flex items-center gap-2">
            <PermissionButton
              permissions={{ chatSettings: ["update"] }}
              size="sm"
              variant="outline"
              onClick={openBulkAssignDialog}
              data-testid={E2eTestId.BulkAssignChatApiKeysButton}
            >
              <Users className="h-4 w-4 mr-2" />
              Assign to Profiles
            </PermissionButton>
          </div>
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            Clear selection
          </Button>
        </div>
      )}

      <div data-testid={E2eTestId.ChatApiKeysTable}>
        <DataTable
          columns={columns}
          data={apiKeys}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          getRowId={(row) => row.id}
        />
      </div>

      {/* Create Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add API Key</DialogTitle>
            <DialogDescription>
              Add a new LLM provider API key for use in Chat
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="My Anthropic Key"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="provider">Provider</Label>
              <Select
                value={newKeyProvider}
                onValueChange={(v) =>
                  setNewKeyProvider(v as SupportedChatProvider)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PROVIDER_CONFIG).map(([key, config]) => (
                    <SelectItem
                      key={key}
                      value={key}
                      disabled={!config.enabled}
                    >
                      <div className="flex items-center gap-2">
                        <Image
                          src={config.icon}
                          alt={config.name}
                          width={16}
                          height={16}
                          className="rounded"
                        />
                        <span>{config.name}</span>
                        {!config.enabled && (
                          <Badge variant="outline" className="ml-2 text-xs">
                            Coming Soon
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="apiKey">API Key</Label>
              <Input
                id="apiKey"
                type="password"
                placeholder={PROVIDER_CONFIG[newKeyProvider].placeholder}
                value={newKeyValue}
                onChange={(e) => setNewKeyValue(e.target.value)}
              />
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="isDefault"
                checked={newKeyIsDefault}
                onCheckedChange={(checked) =>
                  setNewKeyIsDefault(checked === true)
                }
              />
              <Label htmlFor="isDefault" className="text-sm font-normal">
                Set as organization default for{" "}
                {PROVIDER_CONFIG[newKeyProvider].name}
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsCreateDialogOpen(false);
                resetCreateForm();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                !newKeyName || !newKeyValue || createApiKeyMutation.isPending
              }
            >
              {createApiKeyMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit API Key</DialogTitle>
            <DialogDescription>
              Update the name or API key value
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="editName">Name</Label>
              <Input
                id="editName"
                value={editKeyName}
                onChange={(e) => setEditKeyName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="editApiKey">
                API Key{" "}
                <span className="text-muted-foreground font-normal">
                  (leave blank to keep current)
                </span>
              </Label>
              <Input
                id="editApiKey"
                type="password"
                placeholder="••••••••••••••••"
                value={editKeyValue}
                onChange={(e) => setEditKeyValue(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsEditDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleEdit}
              disabled={updateApiKeyMutation.isPending}
            >
              {updateApiKeyMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete API Key</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{selectedApiKey?.name}
              &quot;? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteApiKeyMutation.isPending}
            >
              {deleteApiKeyMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Profiles Assignment Dialog */}
      <Dialog
        open={isProfilesDialogOpen}
        onOpenChange={setIsProfilesDialogOpen}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Manage Profile Assignments</DialogTitle>
            <DialogDescription>
              Select which profiles should use this API key
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 max-h-[300px] overflow-y-auto">
            {allProfiles.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No profiles available
              </p>
            ) : (
              <div className="space-y-2">
                {allProfiles.map((profile) => (
                  <div
                    key={profile.id}
                    className="flex items-center space-x-2 p-2 rounded hover:bg-muted"
                  >
                    <Checkbox
                      id={`profile-${profile.id}`}
                      checked={selectedProfileIds.includes(profile.id)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedProfileIds([
                            ...selectedProfileIds,
                            profile.id,
                          ]);
                        } else {
                          setSelectedProfileIds(
                            selectedProfileIds.filter(
                              (id) => id !== profile.id,
                            ),
                          );
                        }
                      }}
                    />
                    <Label
                      htmlFor={`profile-${profile.id}`}
                      className="flex-1 cursor-pointer"
                    >
                      {profile.name}
                    </Label>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsProfilesDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpdateProfiles}
              disabled={updateProfilesMutation.isPending}
            >
              {updateProfilesMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Assign Dialog */}
      <Dialog
        open={isBulkAssignDialogOpen}
        onOpenChange={setIsBulkAssignDialogOpen}
      >
        <DialogContent
          className="max-w-md"
          data-testid={E2eTestId.BulkAssignChatApiKeysDialog}
        >
          <DialogHeader>
            <DialogTitle>Assign to Profiles</DialogTitle>
            <DialogDescription>
              Assign {selectedApiKeyIds.length} selected API key(s) to profiles.
              Note: Only one key per provider is allowed per profile. Existing
              assignments for the same provider will be replaced.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 max-h-[300px] overflow-y-auto">
            {allProfiles.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No profiles available
              </p>
            ) : (
              <div className="space-y-2">
                {allProfiles.map((profile) => (
                  <div
                    key={profile.id}
                    className="flex items-center space-x-2 p-2 rounded hover:bg-muted"
                  >
                    <Checkbox
                      id={`bulk-profile-${profile.id}`}
                      checked={bulkAssignProfileIds.includes(profile.id)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setBulkAssignProfileIds([
                            ...bulkAssignProfileIds,
                            profile.id,
                          ]);
                        } else {
                          setBulkAssignProfileIds(
                            bulkAssignProfileIds.filter(
                              (id) => id !== profile.id,
                            ),
                          );
                        }
                      }}
                    />
                    <Label
                      htmlFor={`bulk-profile-${profile.id}`}
                      className="flex-1 cursor-pointer"
                    >
                      {profile.name}
                    </Label>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsBulkAssignDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleBulkAssign}
              disabled={
                bulkAssignMutation.isPending ||
                bulkAssignProfileIds.length === 0 ||
                selectedApiKeyIds.length === 0
              }
            >
              {bulkAssignMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ChatSettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      }
    >
      <ChatSettingsContent />
    </Suspense>
  );
}
