"use client";

import {
  E2eTestId,
  formatSecretStorageType,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
  type SupportedProvider,
} from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  Building2,
  Check,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Star,
  Trash2,
  User,
  Users,
  Zap,
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  type ModelWithApiKeys,
  useModelsWithApiKeys,
} from "@/lib/chat-models.query";
import {
  type ChatApiKeyScope,
  useChatApiKeys,
  useCreateChatApiKey,
  useDeleteChatApiKey,
  useSyncChatModels,
  useUpdateChatApiKey,
} from "@/lib/chat-settings.query";
import { useFeatureFlag } from "@/lib/features.hook";

const SCOPE_ICONS: Record<ChatApiKeyScope, React.ReactNode> = {
  personal: <User className="h-3 w-3" />,
  team: <Users className="h-3 w-3" />,
  org_wide: <Building2 className="h-3 w-3" />,
};

/**
 * Format context length for display (e.g., 128000 -> "128K", 1000000 -> "1M")
 */
function formatContextLength(contextLength: number | null): string {
  if (contextLength === null) return "-";
  if (contextLength >= 1000000) {
    return `${(contextLength / 1000000).toFixed(contextLength % 1000000 === 0 ? 0 : 1)}M`;
  }
  if (contextLength >= 1000) {
    return `${(contextLength / 1000).toFixed(contextLength % 1000 === 0 ? 0 : 1)}K`;
  }
  return contextLength.toString();
}

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
  const { data: apiKeys = [], isPending } = useChatApiKeys();
  const createMutation = useCreateChatApiKey();
  const updateMutation = useUpdateChatApiKey();
  const deleteMutation = useDeleteChatApiKey();
  const syncModelsMutation = useSyncChatModels();
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
    const result = await deleteMutation.mutateAsync(selectedApiKey.id);
    if (result) {
      setIsDeleteDialogOpen(false);
      setSelectedApiKey(null);
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
              onClick={() => syncModelsMutation.mutate()}
              disabled={syncModelsMutation.isPending}
            >
              <RefreshCw
                className={`h-4 w-4 mr-2 ${syncModelsMutation.isPending ? "animate-spin" : ""}`}
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
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Add API Key</DialogTitle>
              <DialogDescription>
                Add a new LLM provider API key for use in Chat
              </DialogDescription>
            </DialogHeader>
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
    </LoadingWrapper>
  );
}

/**
 * Check if a model has unknown capabilities (no data available)
 */
function hasUnknownCapabilities(model: ModelWithApiKeys): boolean {
  const capabilities = model.capabilities;
  if (!capabilities) return true;

  const hasInputModalities =
    capabilities.inputModalities && capabilities.inputModalities.length > 0;
  const hasOutputModalities =
    capabilities.outputModalities && capabilities.outputModalities.length > 0;
  const hasToolCalling = capabilities.supportsToolCalling !== null;
  const hasContextLength = capabilities.contextLength !== null;
  const hasPricing =
    capabilities.pricePerMillionInput !== null ||
    capabilities.pricePerMillionOutput !== null;

  return (
    !hasInputModalities &&
    !hasOutputModalities &&
    !hasToolCalling &&
    !hasContextLength &&
    !hasPricing
  );
}

/**
 * Badge for models with unknown capabilities
 */
function UnknownCapabilitiesBadge() {
  return (
    <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded whitespace-nowrap">
      capabilities unknown
    </span>
  );
}

/**
 * Badge for fastest (lowest latency) models
 */
function FastestModelBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950 px-1.5 py-0.5 rounded whitespace-nowrap">
      <Zap className="h-3 w-3" />
      fastest
    </span>
  );
}

/**
 * Badge for best (highest quality) models
 */
function BestModelBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-purple-700 dark:text-purple-400 bg-purple-100 dark:bg-purple-950 px-1.5 py-0.5 rounded whitespace-nowrap">
      <Star className="h-3 w-3" />
      best
    </span>
  );
}

/**
 * Models table showing all models with their linked API keys
 */
function ModelsTable() {
  const { data: models = [], isPending, refetch } = useModelsWithApiKeys();
  const syncModelsMutation = useSyncChatModels();

  const handleRefresh = useCallback(async () => {
    await syncModelsMutation.mutateAsync();
    await refetch();
  }, [syncModelsMutation, refetch]);

  const columns: ColumnDef<ModelWithApiKeys>[] = useMemo(
    () => [
      {
        accessorKey: "provider",
        header: "Provider",
        cell: ({ row }) => {
          const provider = row.original.provider as SupportedProvider;
          const config = PROVIDER_CONFIG[provider];
          if (!config) {
            return <span className="text-sm">{provider}</span>;
          }
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
        accessorKey: "modelId",
        header: "Model ID",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">{row.original.modelId}</span>
            {row.original.isFastest && <FastestModelBadge />}
            {row.original.isBest && <BestModelBadge />}
          </div>
        ),
      },
      {
        accessorKey: "apiKeys",
        header: "API Keys",
        cell: ({ row }) => {
          const apiKeys = row.original.apiKeys;
          if (apiKeys.length === 0) {
            return <span className="text-sm text-muted-foreground">-</span>;
          }
          return (
            <div className="flex flex-wrap gap-1">
              {apiKeys.map((apiKey) => (
                <Badge
                  key={apiKey.id}
                  variant={apiKey.isSystem ? "secondary" : "outline"}
                  className="text-xs gap-1 max-w-full"
                >
                  {apiKey.isSystem ? (
                    <Server className="h-3 w-3 shrink-0" />
                  ) : (
                    <span className="shrink-0">
                      {SCOPE_ICONS[apiKey.scope as ChatApiKeyScope]}
                    </span>
                  )}
                  <span className="truncate">{apiKey.name}</span>
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        accessorKey: "capabilities.contextLength",
        header: "Context",
        cell: ({ row }) => {
          // Show "capabilities unknown" badge if model has no capability data at all
          if (hasUnknownCapabilities(row.original)) {
            return <UnknownCapabilitiesBadge />;
          }
          return (
            <span className="text-sm">
              {formatContextLength(
                row.original.capabilities?.contextLength ?? null,
              )}
            </span>
          );
        },
      },
      {
        accessorKey: "capabilities.inputModalities",
        header: "Input",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) {
            return null;
          }
          const modalities = row.original.capabilities?.inputModalities;
          if (!modalities || modalities.length === 0) {
            return null;
          }
          return (
            <div className="flex flex-wrap gap-1">
              {modalities.map((modality) => (
                <Badge key={modality} variant="secondary" className="text-xs">
                  {modality}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        accessorKey: "capabilities.outputModalities",
        header: "Output",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) {
            return null;
          }
          const modalities = row.original.capabilities?.outputModalities;
          if (!modalities || modalities.length === 0) {
            return null;
          }
          return (
            <div className="flex flex-wrap gap-1">
              {modalities.map((modality) => (
                <Badge key={modality} variant="secondary" className="text-xs">
                  {modality}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        accessorKey: "capabilities.supportsToolCalling",
        header: "Tools",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) {
            return null;
          }
          const supportsTools = row.original.capabilities?.supportsToolCalling;
          if (supportsTools === null || supportsTools === undefined) {
            return null;
          }
          return supportsTools ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : null;
        },
      },
      {
        accessorKey: "capabilities.pricePerMillionInput",
        header: "$/M Input",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) {
            return null;
          }
          const price = row.original.capabilities?.pricePerMillionInput;
          if (!price) {
            return null;
          }
          return <span className="text-sm font-mono">${price}</span>;
        },
      },
      {
        accessorKey: "capabilities.pricePerMillionOutput",
        header: "$/M Output",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) {
            return null;
          }
          const price = row.original.capabilities?.pricePerMillionOutput;
          if (!price) {
            return null;
          }
          return <span className="text-sm font-mono">${price}</span>;
        },
      },
    ],
    [],
  );

  return (
    <LoadingWrapper
      isPending={isPending}
      loadingFallback={
        <div className="flex items-center justify-center h-32">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-lg font-semibold">Available Models</h2>
            <p className="text-sm text-muted-foreground">
              Models available from your configured API keys
            </p>
          </div>
          <Button
            variant="outline"
            onClick={handleRefresh}
            disabled={syncModelsMutation.isPending}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${syncModelsMutation.isPending ? "animate-spin" : ""}`}
            />
            Refresh models
          </Button>
        </div>

        {models.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <p>No models available. Add an API key to see available models.</p>
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={models}
            getRowId={(row) => row.id}
            hideSelectedCount
          />
        )}
      </div>
    </LoadingWrapper>
  );
}

export default function ChatSettingsPage() {
  return (
    <div className="space-y-8">
      <ChatSettingsContent />
      <ModelsTable />
    </div>
  );
}
