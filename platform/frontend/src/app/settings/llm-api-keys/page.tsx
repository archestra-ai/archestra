"use client";

import { E2eTestId, formatSecretStorageType } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  User,
  Users,
} from "lucide-react";
import Image from "next/image";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import {
  ChatApiKeyForm,
  type ChatApiKeyFormValues,
  type ChatApiKeyResponse,
  PLACEHOLDER_KEY,
  PROVIDER_CONFIG,
} from "@/components/chat-api-key-form";
import { GeminiVertexAiAlert } from "@/components/gemini-vertex-ai-alert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type ChatApiKeyScope,
  useChatApiKeys,
  useCreateChatApiKey,
  useDeleteChatApiKey,
  useInvalidateChatModelsCache,
  useUpdateChatApiKey,
} from "@/lib/chat-settings.query";
import { useFeatureFlag } from "@/lib/features.hook";

const SCOPE_ICONS: Record<ChatApiKeyScope, React.ReactNode> = {
  personal: <User className="h-3 w-3" />,
  team: <Users className="h-3 w-3" />,
  org_wide: <Building2 className="h-3 w-3" />,
};

const DEFAULT_FORM_VALUES: ChatApiKeyFormValues = {
  name: "",
  provider: "anthropic",
  apiKey: null,
  scope: "personal",
  teamId: null,
  vaultSecretPath: null,
  vaultSecretKey: null,
};

function ChatSettingsContent() {
  const { data: apiKeys = [] } = useChatApiKeys();
  const createMutation = useCreateChatApiKey();
  const updateMutation = useUpdateChatApiKey();
  const deleteMutation = useDeleteChatApiKey();
  const invalidateCacheMutation = useInvalidateChatModelsCache();
  const byosEnabled = useFeatureFlag("byosEnabled");
  const geminiVertexAiEnabled = useFeatureFlag("geminiVertexAiEnabled");

  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedApiKey, setSelectedApiKey] =
    useState<ChatApiKeyResponse | null>(null);

  // Forms
  const createForm = useForm<ChatApiKeyFormValues>({
    defaultValues: DEFAULT_FORM_VALUES,
  });

  const editForm = useForm<ChatApiKeyFormValues>({
    defaultValues: DEFAULT_FORM_VALUES,
  });

  // Reset create form when dialog opens
  useEffect(() => {
    if (isCreateDialogOpen) {
      createForm.reset(DEFAULT_FORM_VALUES);
    }
  }, [isCreateDialogOpen, createForm]);

  // Reset edit form with selected key values when dialog opens
  useEffect(() => {
    if (isEditDialogOpen && selectedApiKey) {
      editForm.reset({
        name: selectedApiKey.name,
        provider: selectedApiKey.provider,
        apiKey: PLACEHOLDER_KEY,
        scope: selectedApiKey.scope,
        teamId: selectedApiKey.teamId ?? "",
        // Include vault secret info for BYOS mode
        vaultSecretPath: selectedApiKey.vaultSecretPath ?? null,
        vaultSecretKey: selectedApiKey.vaultSecretKey ?? null,
      });
    }
  }, [isEditDialogOpen, selectedApiKey, editForm]);

  // Submit handlers
  const handleCreate = createForm.handleSubmit(async (values) => {
    await createMutation.mutateAsync({
      name: values.name,
      provider: values.provider,
      apiKey: values.apiKey ?? undefined,
      scope: values.scope,
      teamId:
        values.scope === "team" && values.teamId ? values.teamId : undefined,
      vaultSecretPath:
        byosEnabled && values.vaultSecretPath
          ? values.vaultSecretPath
          : undefined,
      vaultSecretKey:
        byosEnabled && values.vaultSecretKey
          ? values.vaultSecretKey
          : undefined,
    });

    createForm.reset(DEFAULT_FORM_VALUES);
    setIsCreateDialogOpen(false);
  });

  const handleEdit = editForm.handleSubmit(async (values) => {
    if (!selectedApiKey) return;

    const apiKeyChanged =
      values.apiKey !== PLACEHOLDER_KEY && values.apiKey !== "";

    // Detect scope/team changes
    const scopeChanged = values.scope !== selectedApiKey.scope;
    const teamIdChanged = values.teamId !== (selectedApiKey.teamId ?? "");

    await updateMutation.mutateAsync({
      id: selectedApiKey.id,
      data: {
        name: values.name || undefined,
        apiKey: apiKeyChanged ? (values.apiKey ?? undefined) : undefined,
        scope: scopeChanged ? values.scope : undefined,
        teamId:
          scopeChanged || teamIdChanged
            ? values.scope === "team"
              ? values.teamId
              : null
            : undefined,
        vaultSecretPath:
          byosEnabled && values.vaultSecretPath
            ? values.vaultSecretPath
            : undefined,
        vaultSecretKey:
          byosEnabled && values.vaultSecretKey
            ? values.vaultSecretKey
            : undefined,
      },
    });

    setIsEditDialogOpen(false);
    setSelectedApiKey(null);
  });

  const handleDelete = useCallback(async () => {
    if (!selectedApiKey) return;
    try {
      await deleteMutation.mutateAsync(selectedApiKey.id);
      toast.success("API key deleted successfully");
      setIsDeleteDialogOpen(false);
      setSelectedApiKey(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to delete API key";
      toast.error(message);
    }
  }, [selectedApiKey, deleteMutation]);

  const openEditDialog = useCallback((apiKey: ChatApiKeyResponse) => {
    setSelectedApiKey(apiKey);
    setIsEditDialogOpen(true);
  }, []);

  const openDeleteDialog = useCallback((apiKey: ChatApiKeyResponse) => {
    setSelectedApiKey(apiKey);
    setIsDeleteDialogOpen(true);
  }, []);

  // Validation for create form
  const createFormValues = createForm.watch();
  const isCreateValid =
    createFormValues.apiKey !== PLACEHOLDER_KEY &&
    createFormValues.name &&
    (createFormValues.scope !== "team" || createFormValues.teamId) &&
    (byosEnabled
      ? createFormValues.vaultSecretPath && createFormValues.vaultSecretKey
      : createFormValues.apiKey);

  // Validation for edit form
  const editFormValues = editForm.watch();
  const isEditValid = Boolean(editFormValues.name);

  const columns: ColumnDef<ChatApiKeyResponse>[] = useMemo(
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
                className="rounded dark:invert"
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
                  <span>
                    {row.original.scope === "team"
                      ? row.original.teamName
                      : row.original.scope === "personal"
                        ? "Personal"
                        : "Whole Organization"}
                  </span>
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                {row.original.scope === "personal" && (
                  <p>Only available to you</p>
                )}
                {row.original.scope === "team" && (
                  <p>Available to team members of {row.original.teamName}</p>
                )}
                {row.original.scope === "org_wide" && (
                  <p>Available to all members of your organization</p>
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ),
      },
      {
        accessorKey: "secretStorageType",
        header: "Storage",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatSecretStorageType(row.original.secretStorageType)}
          </span>
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
              permissions={{
                chatSettings: ["update"],
                ...(row.original.scope === "org_wide"
                  ? { team: ["admin"] }
                  : {}),
              }}
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
              permissions={{
                chatSettings: ["delete"],
                ...(row.original.scope === "org_wide"
                  ? { team: ["admin"] }
                  : {}),
              }}
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
    [openEditDialog, openDeleteDialog],
  );

  return (
    <div className="space-y-4">
      <span id="chunk-test" style={{ visibility: "hidden" }}>
        {" "}
      </span>
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">LLM Provider API Keys</h2>
          <p className="text-sm text-muted-foreground">
            Manage API keys for LLM providers used in the Archestra Chat
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => invalidateCacheMutation.mutate()}
            disabled={invalidateCacheMutation.isPending}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${invalidateCacheMutation.isPending ? "animate-spin" : ""}`}
            />
            Refresh models
          </Button>
          <Button
            onClick={() => setIsCreateDialogOpen(true)}
            data-testid={E2eTestId.AddChatApiKeyButton}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add API Key
          </Button>
        </div>
      </div>

      {byosEnabled &&
        apiKeys.some((key) => key.secretStorageType === "database") && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Database-stored API keys detected</AlertTitle>
            <AlertDescription>
              External Vault storage is enabled, but some of your API keys are
              still stored in the database. To migrate them to the vault, delete
              them and create new ones with vault references.
            </AlertDescription>
          </Alert>
        )}

      {geminiVertexAiEnabled && <GeminiVertexAiAlert variant="full" />}

      <div data-testid={E2eTestId.ChatApiKeysTable}>
        <DataTable
          columns={columns}
          data={apiKeys}
          getRowId={(row) => row.id}
          hideSelectedCount
        />
      </div>

      {/* Create Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add API Key</DialogTitle>
            <DialogDescription>
              Add a new LLM provider API key for use in Chat
            </DialogDescription>
          </DialogHeader>
          {geminiVertexAiEnabled && <GeminiVertexAiAlert variant="compact" />}
          <div className="py-2">
            <ChatApiKeyForm
              mode="full"
              showConsoleLink={false}
              form={createForm}
              existingKeys={apiKeys}
              isPending={createMutation.isPending}
              geminiVertexAiEnabled={geminiVertexAiEnabled}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsCreateDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!isCreateValid || createMutation.isPending}
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Test & Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit API Key</DialogTitle>
            <DialogDescription>
              Update the name or API key value
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {selectedApiKey && (
              <ChatApiKeyForm
                mode="full"
                showConsoleLink={false}
                existingKey={selectedApiKey}
                existingKeys={apiKeys}
                form={editForm}
                isPending={updateMutation.isPending}
              />
            )}
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
              disabled={!isEditValid || updateMutation.isPending}
            >
              {updateMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Test & Save
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
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
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
