"use client";

import {
  E2eTestId,
  formatSecretStorageType,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
} from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  Server,
  Trash2,
  User,
  Users,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import {
  ChatApiKeyForm,
  type ChatApiKeyFormValues,
  type ChatApiKeyResponse,
  PLACEHOLDER_KEY,
  PROVIDER_CONFIG,
} from "@/components/chat-api-key-form";
import { LoadingWrapper } from "@/components/loading";
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
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineTag } from "@/components/ui/inline-tag";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  type ChatApiKeyScope,
  useChatApiKeys,
  useCreateChatApiKey,
  useDeleteChatApiKey,
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
  baseUrl: null,
  scope: "personal",
  teamId: null,
  vaultSecretPath: null,
  vaultSecretKey: null,
  isPrimary: false,
};

export function ProviderSettingsApiKeys() {
  const { data: apiKeys = [], isPending } = useChatApiKeys();
  const createMutation = useCreateChatApiKey();
  const updateMutation = useUpdateChatApiKey();
  const deleteMutation = useDeleteChatApiKey();
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

  // Reset create form when dialog opens.
  // isPrimary is handled by the child ChatApiKeyForm component, which watches
  // the current provider and sets isPrimary based on whether keys exist for it.
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
        baseUrl: selectedApiKey.baseUrl ?? null,
        scope: selectedApiKey.scope,
        teamId: selectedApiKey.teamId ?? "",
        vaultSecretPath: selectedApiKey.vaultSecretPath ?? null,
        vaultSecretKey: selectedApiKey.vaultSecretKey ?? null,
        isPrimary: selectedApiKey.isPrimary ?? false,
      });
    }
  }, [isEditDialogOpen, selectedApiKey, editForm]);

  // Submit handlers
  const handleCreate = createForm.handleSubmit(async (values) => {
    try {
      const _created = await createMutation.mutateAsync({
        name: values.name,
        provider: values.provider,
        apiKey: values.apiKey || undefined,
        baseUrl: values.baseUrl || undefined,
        scope: values.scope,
        teamId:
          values.scope === "team" && values.teamId ? values.teamId : undefined,
        isPrimary: values.isPrimary,
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
    } catch {
      // Error already handled by mutation's handleApiError
    }
  });

  const handleEdit = editForm.handleSubmit(async (values) => {
    if (!selectedApiKey) return;

    const apiKeyChanged =
      values.apiKey !== PLACEHOLDER_KEY && values.apiKey !== "";

    // Detect scope/team changes
    const scopeChanged = values.scope !== selectedApiKey.scope;
    const teamIdChanged = values.teamId !== (selectedApiKey.teamId ?? "");

    try {
      await updateMutation.mutateAsync({
        id: selectedApiKey.id,
        data: {
          name: values.name || undefined,
          apiKey: apiKeyChanged ? (values.apiKey ?? undefined) : undefined,
          baseUrl: values.baseUrl || null,
          scope: scopeChanged ? values.scope : undefined,
          teamId:
            scopeChanged || teamIdChanged
              ? values.scope === "team"
                ? values.teamId
                : null
              : undefined,
          isPrimary: values.isPrimary,
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
    } catch {
      // Error already handled by mutation's handleApiError
    }
  });

  const handleDelete = useCallback(async () => {
    if (!selectedApiKey) return;
    try {
      await deleteMutation.mutateAsync(selectedApiKey.id);
      setIsDeleteDialogOpen(false);
      setSelectedApiKey(null);
    } catch {
      // Error already handled by mutation's handleApiError
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
      : PROVIDERS_WITH_OPTIONAL_API_KEY.has(createFormValues.provider) ||
        createFormValues.apiKey);

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
            <span className="font-medium break-all">{row.original.name}</span>
            {row.original.isPrimary && (
              <InlineTag className="text-amber-500 bg-amber-500/15 border border-amber-500/20">
                Primary
              </InlineTag>
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
          <Badge
            variant={row.original.isSystem ? "secondary" : "outline"}
            className="gap-1"
          >
            {row.original.isSystem ? (
              <Server className="h-3 w-3" />
            ) : (
              SCOPE_ICONS[row.original.scope]
            )}
            <span>
              {row.original.isSystem
                ? "System"
                : row.original.scope === "team"
                  ? row.original.teamName
                  : row.original.scope === "personal"
                    ? "Personal"
                    : "Whole Organization"}
            </span>
          </Badge>
        ),
      },
      {
        accessorKey: "secretStorageType",
        header: "Storage",
        cell: ({ row }) =>
          row.original.isSystem ? (
            <span className="text-sm text-muted-foreground">
              Env Vars{" "}
              <a
                href="https://archestra.ai/docs/platform-supported-llm-providers#using-vertex-ai"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Docs
                <ExternalLink className="h-3 w-3" />
              </a>
            </span>
          ) : (
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
            {row.original.isSystem || row.original.secretId ? (
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
        cell: ({ row }) => {
          const isSystem = row.original.isSystem;
          return (
            <ButtonGroup>
              <PermissionButton
                permissions={{
                  chatSettings: ["update"],
                  ...(row.original.scope === "org_wide"
                    ? { team: ["admin"] }
                    : {}),
                }}
                aria-label="Edit"
                variant="outline"
                size="icon-sm"
                disabled={isSystem}
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
                aria-label="Delete"
                variant="outline"
                size="icon-sm"
                disabled={isSystem}
                data-testid={`${E2eTestId.DeleteChatApiKeyButton}-${row.original.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  openDeleteDialog(row.original);
                }}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </PermissionButton>
            </ButtonGroup>
          );
        },
      },
    ],
    [openEditDialog, openDeleteDialog],
  );

  return (
    <LoadingWrapper
      isPending={isPending}
      loadingFallback={
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-3">
          <div>
            <h2 className="text-lg font-semibold">LLM API Keys</h2>
            <p className="text-sm text-muted-foreground">
              Manage API keys for LLM providers used in Chat and LLM Proxy
            </p>
          </div>
          <Button
            className="shrink-0"
            onClick={() => setIsCreateDialogOpen(true)}
            data-testid={E2eTestId.AddChatApiKeyButton}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add API Key
          </Button>
        </div>

        {byosEnabled &&
          apiKeys.some((key) => key.secretStorageType === "database") && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Database-stored API keys detected</AlertTitle>
              <AlertDescription>
                External Vault storage is enabled, but some of your API keys are
                still stored in the database. To migrate them to the vault,
                delete them and create new ones with vault references.
              </AlertDescription>
            </Alert>
          )}

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
          <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add API Key</DialogTitle>
              <DialogDescription>
                Add a new LLM provider API key for use in Chat and LLM Proxy
              </DialogDescription>
            </DialogHeader>
            <DialogForm onSubmit={handleCreate}>
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
                  type="button"
                  variant="outline"
                  onClick={() => setIsCreateDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!isCreateValid || createMutation.isPending}
                >
                  {createMutation.isPending && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Test & Create
                </Button>
              </DialogFooter>
            </DialogForm>
          </DialogContent>
        </Dialog>

        {/* Edit Dialog */}
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit API Key</DialogTitle>
              <DialogDescription>
                Update the name, API key value, or scope
              </DialogDescription>
            </DialogHeader>
            <DialogForm onSubmit={handleEdit}>
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
                  type="button"
                  variant="outline"
                  onClick={() => setIsEditDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!isEditValid || updateMutation.isPending}
                >
                  {updateMutation.isPending && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Test & Save
                </Button>
              </DialogFooter>
            </DialogForm>
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
            <DialogForm onSubmit={handleDelete}>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsDeleteDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={deleteMutation.isPending}
                >
                  {deleteMutation.isPending && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Delete
                </Button>
              </DialogFooter>
            </DialogForm>
          </DialogContent>
        </Dialog>
      </div>
    </LoadingWrapper>
  );
}
