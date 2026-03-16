"use client";

import {
  DocsPage,
  E2eTestId,
  formatSecretStorageType,
  getDocsUrl,
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
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { LlmProviderSelectItems } from "@/components/llm-provider-options";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { InlineTag } from "@/components/ui/inline-tag";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type ChatApiKeyScope,
  useChatApiKeys,
  useCreateChatApiKey,
  useDeleteChatApiKey,
  useUpdateChatApiKey,
} from "@/lib/chat-settings.query";
import { useFeature } from "@/lib/config.query";
import { useOrganization } from "@/lib/organization.query";
import { useDataTableQueryParams } from "@/lib/use-data-table-query-params";
import { useSetProviderAction } from "../layout";

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

export default function ApiKeysPage() {
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const search = searchParams.get("search") || "";
  const providerFilter = searchParams.get("provider") || "all";
  const { data: allApiKeys = [] } = useChatApiKeys();
  const { data: queriedApiKeys = [], isPending } = useChatApiKeys({
    search: search || undefined,
    provider:
      providerFilter === "all"
        ? undefined
        : (providerFilter as ChatApiKeyResponse["provider"]),
  });
  const { data: organization } = useOrganization();
  const createMutation = useCreateChatApiKey();
  const updateMutation = useUpdateChatApiKey();
  const deleteMutation = useDeleteChatApiKey();
  const byosEnabled = useFeature("byosEnabled");
  const geminiVertexAiEnabled = useFeature("geminiVertexAiEnabled");

  const getKeyUsage = useCallback(
    (keyId: string): string | null => {
      if (!organization) return null;
      const usages: string[] = [];
      if (organization.embeddingChatApiKeyId === keyId)
        usages.push("embedding");
      if (organization.rerankerChatApiKeyId === keyId) usages.push("reranking");
      return usages.length > 0
        ? `Used for knowledge base ${usages.join(" and ")}`
        : null;
    },
    [organization],
  );

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

  const setProviderAction = useSetProviderAction();
  useEffect(() => {
    setProviderAction(
      <PermissionButton
        permissions={{ llmProvider: ["create"] }}
        onClick={() => setIsCreateDialogOpen(true)}
        data-testid={E2eTestId.AddChatApiKeyButton}
      >
        <Plus className="h-4 w-4 mr-2" />
        Add API Key
      </PermissionButton>,
    );
    return () => setProviderAction(null);
  }, [setProviderAction]);

  const apiKeys = queriedApiKeys;

  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    return allApiKeys
      .filter((apiKey) => {
        if (seen.has(apiKey.provider)) return false;
        seen.add(apiKey.provider);
        return true;
      })
      .map((apiKey) => {
        const config = PROVIDER_CONFIG[apiKey.provider];
        return {
          value: apiKey.provider,
          icon: config.icon,
          name: config.name,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allApiKeys]);

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
                href={getDocsUrl(
                  DocsPage.PlatformSupportedLlmProviders,
                  "using-vertex-ai",
                )}
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
          const keyUsage = getKeyUsage(row.original.id);
          const isInUse = !!keyUsage;
          return (
            <TableRowActions
              actions={[
                {
                  icon: <Pencil className="h-4 w-4" />,
                  label: "Edit",
                  permissions: {
                    llmProvider: ["update"],
                    ...(row.original.scope === "org_wide"
                      ? { team: ["admin"] }
                      : {}),
                  },
                  disabled: isSystem,
                  disabledTooltip: "System keys cannot be edited",
                  onClick: () => openEditDialog(row.original),
                  testId: `${E2eTestId.EditChatApiKeyButton}-${row.original.name}`,
                },
                {
                  icon: <Trash2 className="h-4 w-4" />,
                  label: "Delete",
                  variant: "destructive",
                  permissions: {
                    llmProvider: ["delete"],
                    ...(row.original.scope === "org_wide"
                      ? { team: ["admin"] }
                      : {}),
                  },
                  disabled: isSystem || isInUse,
                  disabledTooltip: isInUse
                    ? `${keyUsage}. Remove it from Settings > Knowledge before deleting.`
                    : "System keys cannot be deleted",
                  onClick: () => openDeleteDialog(row.original),
                  testId: `${E2eTestId.DeleteChatApiKeyButton}-${row.original.name}`,
                },
              ]}
            />
          );
        },
      },
    ],
    [openEditDialog, openDeleteDialog, getKeyUsage],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          objectNamePlural="API keys"
          searchFields={["name"]}
          paramName="search"
        />
        <Select
          value={providerFilter}
          onValueChange={(value) =>
            updateQueryParams({
              provider: value === "all" ? null : value,
            })
          }
        >
          <SelectTrigger className="w-full sm:w-[240px]">
            <SelectValue placeholder="All providers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            <LlmProviderSelectItems options={providerOptions} />
          </SelectContent>
        </Select>
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

      <div data-testid={E2eTestId.ChatApiKeysTable}>
        <DataTable
          columns={columns}
          data={apiKeys}
          getRowId={(row) => row.id}
          hideSelectedCount
          isLoading={isPending}
          emptyMessage="No API keys configured"
          hasActiveFilters={Boolean(search || providerFilter !== "all")}
          filteredEmptyMessage="No LLM provider API keys match your filters. Try adjusting your search."
          onClearFilters={() =>
            updateQueryParams({
              search: null,
              provider: null,
            })
          }
        />
      </div>

      {/* Create Dialog */}
      <FormDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        title="Add API Key"
        description="Add a new LLM provider API key for use in Chat and LLM Proxy"
        size="small"
      >
        <DialogForm
          onSubmit={handleCreate}
          className="flex min-h-0 flex-1 flex-col"
        >
          <DialogBody>
            <ChatApiKeyForm
              mode="full"
              showConsoleLink={false}
              form={createForm}
              existingKeys={apiKeys}
              isPending={createMutation.isPending}
              geminiVertexAiEnabled={geminiVertexAiEnabled}
            />
          </DialogBody>
          <DialogStickyFooter className="mt-0">
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
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      {/* Edit Dialog */}
      <FormDialog
        open={isEditDialogOpen}
        onOpenChange={setIsEditDialogOpen}
        title="Edit API Key"
        description="Update the name, API key value, or scope"
        size="small"
      >
        <DialogForm
          onSubmit={handleEdit}
          className="flex min-h-0 flex-1 flex-col"
        >
          <DialogBody>
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
          </DialogBody>
          <DialogStickyFooter className="mt-0">
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
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete API Key"
        description={`Are you sure you want to delete "${selectedApiKey?.name}"? This action cannot be undone.`}
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
        confirmLabel="Delete API Key"
        pendingLabel="Deleting..."
      />
    </div>
  );
}
