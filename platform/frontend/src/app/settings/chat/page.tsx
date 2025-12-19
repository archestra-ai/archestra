"use client";

import { E2eTestId } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Building2,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  User,
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
import {
  type ChatApiKey,
  type ChatApiKeyScope,
  useChatApiKeys,
  useCreateChatApiKey,
  useDeleteChatApiKey,
  useUpdateChatApiKey,
} from "@/lib/chat-settings.query";
import { useTeams } from "@/lib/team.query";

const SCOPE_ICONS: Record<ChatApiKeyScope, React.ReactNode> = {
  personal: <User className="h-3 w-3" />,
  team: <Users className="h-3 w-3" />,
  org_wide: <Building2 className="h-3 w-3" />,
};

function ChatSettingsContent() {
  const { data: apiKeys = [] } = useChatApiKeys();
  const { data: teams = [] } = useTeams();
  const createApiKeyMutation = useCreateChatApiKey();
  const updateApiKeyMutation = useUpdateChatApiKey();
  const deleteApiKeyMutation = useDeleteChatApiKey();

  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedApiKey, setSelectedApiKey] = useState<ChatApiKey | null>(null);

  // Form states
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyProvider, setNewKeyProvider] =
    useState<SupportedChatProvider>("anthropic");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [newKeyScope, setNewKeyScope] = useState<ChatApiKeyScope>("personal");
  const [newKeyTeamId, setNewKeyTeamId] = useState<string>("");
  const [editKeyName, setEditKeyName] = useState("");
  const [editKeyValue, setEditKeyValue] = useState("");

  const resetCreateForm = useCallback(() => {
    setNewKeyName("");
    setNewKeyProvider("anthropic");
    setNewKeyValue("");
    setNewKeyScope("personal");
    setNewKeyTeamId("");
  }, []);

  const handleCreate = useCallback(async () => {
    try {
      await createApiKeyMutation.mutateAsync({
        name: newKeyName,
        provider: newKeyProvider,
        apiKey: newKeyValue,
        scope: newKeyScope,
        teamId: newKeyScope === "team" ? newKeyTeamId : undefined,
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
    newKeyScope,
    newKeyTeamId,
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

  const getScopeDisplayText = useCallback((apiKey: ChatApiKey) => {
    if (apiKey.scope === "personal") {
      return apiKey.userName || "Personal";
    }
    if (apiKey.scope === "team") {
      return apiKey.teamName || "Team";
    }
    return "Organization";
  }, []);

  const columns: ColumnDef<ChatApiKey>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div
            className="flex items-center gap-2"
            data-testid={`${E2eTestId.ChatApiKeyRow}-${row.original.name}`}
          >
            <span className="font-medium">{row.original.name}</span>
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
        accessorKey: "scope",
        header: "Scope",
        cell: ({ row }) => (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="gap-1">
                  {SCOPE_ICONS[row.original.scope]}
                  <span>{getScopeDisplayText(row.original)}</span>
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                {row.original.scope === "personal" && (
                  <p>Only visible to you</p>
                )}
                {row.original.scope === "team" && (
                  <p>Available to team members of {row.original.teamName}</p>
                )}
                {row.original.scope === "org_wide" && (
                  <p>Available to all organization members</p>
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
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
    [openEditDialog, openDeleteDialog, getScopeDisplayText],
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

      <div data-testid={E2eTestId.ChatApiKeysTable}>
        <DataTable
          columns={columns}
          data={apiKeys}
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
            <div className="space-y-2">
              <Label htmlFor="scope">Visibility</Label>
              <Select
                value={newKeyScope}
                onValueChange={(v) => {
                  setNewKeyScope(v as ChatApiKeyScope);
                  if (v !== "team") {
                    setNewKeyTeamId("");
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4" />
                      <span>Personal - Only visible to you</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="team">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      <span>Team - Visible to team members</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="org_wide">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4" />
                      <span>Organization - Visible to everyone</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {newKeyScope === "team" && (
              <div className="space-y-2">
                <Label htmlFor="team">Team</Label>
                <Select value={newKeyTeamId} onValueChange={setNewKeyTeamId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a team" />
                  </SelectTrigger>
                  <SelectContent>
                    {teams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
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
                !newKeyName ||
                !newKeyValue ||
                (newKeyScope === "team" && !newKeyTeamId) ||
                createApiKeyMutation.isPending
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
