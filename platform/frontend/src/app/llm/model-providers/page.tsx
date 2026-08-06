"use client";

import {
  type archestraApiTypes,
  E2eTestId,
  formatSecretStorageType,
  isProviderApiKeyOptional,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { FormDialog } from "@/components/form-dialog";
import {
  deserializeExtraHeaders,
  LLM_PROVIDER_API_KEY_PLACEHOLDER,
  LlmProviderApiKeyForm,
  type LlmProviderApiKeyFormValues,
  type LlmProviderApiKeyResponse,
  PROVIDER_CONFIG,
  serializeExtraHeaders,
} from "@/components/llm-provider-api-key-form";
import { LlmProviderSelectItems } from "@/components/llm-provider-select-items";
import { PageLayout } from "@/components/page-layout";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { platformOwnedStyles } from "@/components/scope-vocabulary";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { useLlmOauthClients } from "@/lib/llm-oauth-clients.query";
import {
  useDeleteLlmProviderApiKey,
  useLlmProviderApiKey,
  useLlmProviderApiKeys,
  useUpdateLlmProviderApiKey,
} from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";
import { MODEL_NAV_TABS } from "../model-nav-tabs";
import { isEditApiKeyFormValid } from "./edit-key-form.utils";

type SubscriptionProvider =
  | "openai"
  | "github-copilot"
  | "microsoft-365-copilot";

type ModelProviderRow =
  | (LlmProviderApiKeyResponse & { kind: "credential" })
  | {
      kind: "subscription";
      id: string;
      name: string;
      provider: SubscriptionProvider;
      scope: "personal";
      isSystem: false;
      isPrimary: false;
      credential: LlmProviderApiKeyResponse | null;
      defaultValues: Partial<LlmProviderApiKeyFormValues>;
    };

const DEFAULT_FORM_VALUES: LlmProviderApiKeyFormValues = {
  name: "",
  provider: "anthropic",
  apiKey: null,
  baseUrl: null,
  inferenceBaseUrl: null,
  extraHeaders: [],
  scope: "personal",
  teamId: null,
  vaultSecretPath: null,
  vaultSecretKey: null,
  isPrimary: false,
  bedrockAuthMethod: "api-key",
  awsAccessKeyId: null,
  awsSecretAccessKey: null,
  awsSessionToken: null,
  openaiAuthMethod: "api-key",
};

const SUBSCRIPTION_PROVIDERS = [
  {
    id: "subscription-chatgpt",
    name: "ChatGPT",
    provider: "openai" as const,
    defaultValues: {
      name: "ChatGPT",
      provider: "openai" as const,
      scope: "personal" as const,
      openaiAuthMethod: "chatgpt-subscription" as const,
    },
  },
  {
    id: "subscription-github-copilot",
    name: "GitHub Copilot",
    provider: "github-copilot" as const,
    defaultValues: {
      name: "GitHub Copilot",
      provider: "github-copilot" as const,
      scope: "personal" as const,
    },
  },
  {
    id: "subscription-microsoft-365-copilot",
    name: "Microsoft 365 Copilot",
    provider: "microsoft-365-copilot" as const,
    defaultValues: {
      name: "Microsoft 365 Copilot",
      provider: "microsoft-365-copilot" as const,
      scope: "personal" as const,
    },
  },
];

export default function ApiKeysPage() {
  const docsUrl = getFrontendDocsUrl("platform-supported-llm-providers");
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const search = searchParams.get("search") || "";
  const providerFilter = searchParams.get("provider") || "all";
  const { data: canReadLlmProviderApiKeys, isPending: permissionsPending } =
    useHasPermissions({ llmProviderApiKey: ["read"] });
  const apiKeyQueriesEnabled =
    !permissionsPending && canReadLlmProviderApiKeys === true;
  const { data: allApiKeys = [] } = useLlmProviderApiKeys({
    enabled: apiKeyQueriesEnabled,
  });
  const { data: queriedApiKeys = [], isPending } = useLlmProviderApiKeys({
    search: search || undefined,
    provider:
      providerFilter === "all"
        ? undefined
        : (providerFilter as LlmProviderApiKeyResponse["provider"]),
    enabled: apiKeyQueriesEnabled,
  });
  const { data: organization } = useOrganization();
  // Read defensively: suites that render this page mock the auth query module
  // wholesale, and the Access column should fall back to the scope label
  // rather than crash the table (same convention as `user-share-field.tsx`).
  const currentUserId = useSession()?.data?.user?.id;
  const updateMutation = useUpdateLlmProviderApiKey();
  const deleteMutation = useDeleteLlmProviderApiKey();
  const byosEnabled = useFeature("byosEnabled");
  const azureOpenAiEntraIdEnabled = useFeature("azureOpenAiEntraIdEnabled");
  const anthropicWifEnabled = useFeature("anthropicWifEnabled");

  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [subscriptionToConnect, setSubscriptionToConnect] = useState<Extract<
    ModelProviderRow,
    { kind: "subscription" }
  > | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedApiKey, setSelectedApiKey] =
    useState<LlmProviderApiKeyResponse | null>(null);

  const editId = searchParams.get("edit");
  const { data: editingApiKeyFromUrl } = useLlmProviderApiKey(
    editId ?? undefined,
  );
  const {
    entity: editingApiKey,
    open: openEditDialog,
    close: closeEditDialog,
  } = useDialogUrlParam<LlmProviderApiKeyResponse>({
    paramName: "edit",
    entityFromUrl: editingApiKeyFromUrl ?? null,
  });

  const selectedApiKeyId = selectedApiKey?.id ?? null;
  const { data: blockingVirtualKeys, isPending: isLoadingVirtualKeys } =
    useAllVirtualApiKeys({
      providerApiKeyId: selectedApiKeyId ?? undefined,
      limit: 100,
      offset: 0,
      enabled: !!selectedApiKeyId && isDeleteDialogOpen,
    });
  const { data: blockingOauthClients = [], isPending: isLoadingOauthClients } =
    useLlmOauthClients({
      providerApiKeyId: selectedApiKeyId ?? undefined,
      enabled: !!selectedApiKeyId && isDeleteDialogOpen,
    });

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

  // Forms
  const editForm = useForm<LlmProviderApiKeyFormValues>({
    defaultValues: DEFAULT_FORM_VALUES,
  });

  // Reset edit form with selected key values when dialog opens
  useEffect(() => {
    if (editingApiKey) {
      editForm.reset({
        name: editingApiKey.name,
        provider: editingApiKey.provider,
        apiKey: editingApiKey.secretId ? LLM_PROVIDER_API_KEY_PLACEHOLDER : "",
        baseUrl: editingApiKey.baseUrl ?? null,
        inferenceBaseUrl: editingApiKey.inferenceBaseUrl ?? null,
        extraHeaders: deserializeExtraHeaders(editingApiKey.extraHeaders),
        scope: editingApiKey.scope,
        teamId: editingApiKey.teamId ?? "",
        vaultSecretPath: editingApiKey.vaultSecretPath ?? null,
        vaultSecretKey: editingApiKey.vaultSecretKey ?? null,
        isPrimary: editingApiKey.isPrimary ?? false,
        bedrockAuthMethod: "api-key",
        awsAccessKeyId: null,
        awsSecretAccessKey: null,
        awsSessionToken: null,
        // Open on the auth-mode tab that matches the stored credential: ChatGPT
        // Subscription keys land on the subscription tab, plain keys on API Key.
        openaiAuthMethod: editingApiKey.isChatgptSubscription
          ? "chatgpt-subscription"
          : "api-key",
      });
    }
  }, [editingApiKey, editForm]);

  const handleEdit = editForm.handleSubmit(async (values) => {
    if (!editingApiKey) return;

    const apiKeyChanged =
      values.apiKey !== LLM_PROVIDER_API_KEY_PLACEHOLDER &&
      values.apiKey !== "";

    // Detect scope/team changes
    const scopeChanged = values.scope !== editingApiKey.scope;
    const teamIdChanged = values.teamId !== (editingApiKey.teamId ?? "");

    const isBedrockSigV4 =
      values.provider === "bedrock" && values.bedrockAuthMethod === "sigv4";
    const sigV4Provided = Boolean(
      isBedrockSigV4 && values.awsAccessKeyId && values.awsSecretAccessKey,
    );

    try {
      await updateMutation.mutateAsync({
        id: editingApiKey.id,
        data: {
          name: values.name || undefined,
          apiKey:
            !isBedrockSigV4 && apiKeyChanged
              ? (values.apiKey ?? undefined)
              : undefined,
          baseUrl: values.baseUrl || null,
          inferenceBaseUrl: values.inferenceBaseUrl || null,
          extraHeaders: serializeExtraHeaders(values.extraHeaders),
          scope: scopeChanged ? values.scope : undefined,
          teamId:
            scopeChanged || teamIdChanged
              ? values.scope === "team"
                ? values.teamId
                : null
              : undefined,
          isPrimary: values.isPrimary,
          vaultSecretPath:
            !isBedrockSigV4 && byosEnabled && values.vaultSecretPath
              ? values.vaultSecretPath
              : undefined,
          vaultSecretKey:
            !isBedrockSigV4 && byosEnabled && values.vaultSecretKey
              ? values.vaultSecretKey
              : undefined,
          awsAccessKeyId: sigV4Provided
            ? (values.awsAccessKeyId ?? undefined)
            : undefined,
          awsSecretAccessKey: sigV4Provided
            ? (values.awsSecretAccessKey ?? undefined)
            : undefined,
          awsSessionToken: sigV4Provided
            ? (values.awsSessionToken ?? undefined)
            : undefined,
        },
      });

      closeEditDialog();
    } catch {
      // Error already handled by mutation's handleApiError
    }
  });

  const handleDelete = useCallback(async () => {
    if (!selectedApiKey) return;
    const hasBlockingAssociations =
      (blockingVirtualKeys?.pagination.total ?? 0) > 0 ||
      blockingOauthClients.length > 0;
    if (hasBlockingAssociations) return;
    try {
      await deleteMutation.mutateAsync(selectedApiKey.id);
      setIsDeleteDialogOpen(false);
      setSelectedApiKey(null);
    } catch {
      // Error already handled by mutation's handleApiError
    }
  }, [
    selectedApiKey,
    blockingVirtualKeys,
    blockingOauthClients,
    deleteMutation,
  ]);

  const openDeleteDialog = useCallback((apiKey: LlmProviderApiKeyResponse) => {
    setSelectedApiKey(apiKey);
    setIsDeleteDialogOpen(true);
  }, []);

  // Validation for edit form
  const editFormValues = editForm.watch();
  const isEditValid = isEditApiKeyFormValid(editFormValues);

  const addApiKeyButton = (
    <PermissionButton
      permissions={{ llmProviderApiKey: ["create"] }}
      onClick={() => setIsCreateDialogOpen(true)}
      data-testid={E2eTestId.AddChatApiKeyButton}
    >
      <Plus className="h-4 w-4" />
      Add API Key
    </PermissionButton>
  );

  const apiKeys = queriedApiKeys;

  const rows = useMemo<ModelProviderRow[]>(() => {
    const subscriptions = SUBSCRIPTION_PROVIDERS.map((subscription) => ({
      kind: "subscription" as const,
      ...subscription,
      scope: "personal" as const,
      isSystem: false as const,
      isPrimary: false as const,
      credential:
        allApiKeys.find(
          (credential) =>
            credential.scope === "personal" &&
            (subscription.provider === "openai"
              ? credential.provider === "openai" &&
                credential.isChatgptSubscription === true
              : credential.provider === subscription.provider),
        ) ?? null,
    }));
    const connectedIds = new Set(
      subscriptions.flatMap(({ credential }) =>
        credential ? [credential.id] : [],
      ),
    );
    const normalizedSearch = search.toLowerCase();

    return [
      ...subscriptions.filter(
        ({ name, provider, credential }) =>
          (providerFilter === "all" || providerFilter === provider) &&
          (!normalizedSearch ||
            `${name} ${PROVIDER_CONFIG[provider].name} ${credential?.name ?? ""}`
              .toLowerCase()
              .includes(normalizedSearch)),
      ),
      ...queriedApiKeys
        .filter(({ id }) => !connectedIds.has(id))
        .map((credential) => ({ kind: "credential" as const, ...credential })),
    ];
  }, [allApiKeys, queriedApiKeys, providerFilter, search]);

  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    return [...SUBSCRIPTION_PROVIDERS, ...allApiKeys]
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

  const columns: ColumnDef<ModelProviderRow>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        size: 230,
        minSize: 180,
        cell: ({ row }) => (
          <div
            className="flex min-w-0 flex-wrap items-center gap-2"
            data-testid={`${E2eTestId.ChatApiKeyRow}-${row.original.name}`}
          >
            <span className="min-w-0 truncate font-medium">
              {row.original.name}
            </span>
            {row.original.kind === "subscription" && (
              <InlineTag className="shrink-0">Subscription</InlineTag>
            )}
            {row.original.isPrimary && (
              <InlineTag className="shrink-0 text-amber-500 bg-amber-500/15 border border-amber-500/20">
                Primary
              </InlineTag>
            )}
          </div>
        ),
      },
      {
        accessorKey: "provider",
        header: "Provider",
        size: 220,
        minSize: 180,
        cell: ({ row }) => {
          const config = PROVIDER_CONFIG[row.original.provider];
          return (
            <div className="flex min-w-0 items-center gap-2">
              <Image
                src={config.icon}
                alt={config.name}
                width={20}
                height={20}
                className="rounded dark:invert"
              />
              <span className="truncate">{config.name}</span>
            </div>
          );
        },
      },
      {
        accessorKey: "scope",
        header: "Access",
        size: 210,
        minSize: 170,
        cell: ({ row }) => {
          const credential = row.original;
          if (credential.kind === "subscription") {
            // A subscription is a personal credential of whoever connected it
            // (today the endpoint only returns the viewer's own, so this reads
            // "Me"); the Name column's "Subscription" tag already says what
            // kind of credential it is, so the Access cell answers only whose.
            return (
              <ResourceVisibilityBadge
                scope="personal"
                teams={undefined}
                authorId={credential.credential?.userId ?? currentUserId}
                authorName={credential.credential?.userName ?? null}
                currentUserId={currentUserId}
                showSelfAsMe
              />
            );
          }
          if (credential.isSystem) {
            // Not a visibility scope: nobody in the org owns this row. It is
            // auto-provisioned because the deployment authenticates with cloud
            // credentials, so it borrows the platform-owned styling that the
            // built-in agent badge uses.
            return (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className={cn(
                        platformOwnedStyles,
                        "max-w-full cursor-help gap-1",
                      )}
                    >
                      <Server className="h-3 w-3" />
                      <span className="truncate">System</span>
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Provisioned automatically because this deployment
                    authenticates with cloud credentials instead of an API key.
                    Managed through environment configuration and usable by the
                    whole organization.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          }
          return (
            <ResourceVisibilityBadge
              scope={credential.scope}
              teams={
                credential.teamId && credential.teamName
                  ? [{ id: credential.teamId, name: credential.teamName }]
                  : undefined
              }
              authorId={credential.userId}
              authorName={credential.userName}
              currentUserId={currentUserId}
              showSelfAsMe
            />
          );
        },
      },
      {
        accessorKey: "secretStorageType",
        header: "Storage",
        size: 120,
        minSize: 100,
        cell: ({ row }) =>
          row.original.kind === "subscription" ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : row.original.isSystem ? (
            <span className="text-sm text-muted-foreground">
              Env Vars{" "}
              {docsUrl && (
                <ExternalDocsLink
                  href={`${docsUrl}#using-vertex-ai`}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Docs
                </ExternalDocsLink>
              )}
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
        size: 150,
        minSize: 130,
        cell: ({ row }) => (
          <div className="flex items-center gap-2 whitespace-nowrap">
            {row.original.kind === "subscription" ? (
              row.original.credential ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <span className="text-sm text-muted-foreground">
                    Connected
                  </span>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">
                  Not connected
                </span>
              )
            ) : row.original.isSystem ||
              row.original.secretId ||
              isProviderApiKeyOptional({
                provider: row.original.provider,
                azureEntraIdEnabled: azureOpenAiEntraIdEnabled === true,
                anthropicWifEnabled: anthropicWifEnabled === true,
              }) ? (
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
        size: 110,
        minSize: 110,
        cell: ({ row }) => {
          if (
            row.original.kind === "subscription" &&
            !row.original.credential
          ) {
            const subscription = row.original;
            return (
              <PermissionButton
                permissions={{ llmProviderApiKey: ["create"] }}
                variant="outline"
                size="sm"
                onClick={() => setSubscriptionToConnect(subscription)}
              >
                Connect
              </PermissionButton>
            );
          }
          const credential =
            row.original.kind === "subscription"
              ? row.original.credential
              : row.original;
          if (!credential) return null;
          const isSystem = credential.isSystem;
          const keyUsage = getKeyUsage(credential.id);
          const isInUse = !!keyUsage;
          return (
            <TableRowActions
              itemName={credential.name}
              actions={[
                {
                  icon: <Pencil className="h-4 w-4" />,
                  label: "Edit",
                  permissions: {
                    llmProviderApiKey: ["update"],
                  },
                  disabled: isSystem,
                  disabledTooltip: "System keys cannot be edited",
                  onClick: () => openEditDialog(credential),
                  testId: `${E2eTestId.EditChatApiKeyButton}-${credential.name}`,
                },
                {
                  icon: <Trash2 className="h-4 w-4" />,
                  label: "Delete",
                  variant: "destructive",
                  permissions: {
                    llmProviderApiKey: ["delete"],
                  },
                  disabled: isSystem || isInUse,
                  disabledTooltip: isInUse
                    ? `${keyUsage}. Remove it from Settings > Knowledge before deleting.`
                    : "System keys cannot be deleted",
                  onClick: () => openDeleteDialog(credential),
                  testId: `${E2eTestId.DeleteChatApiKeyButton}-${credential.name}`,
                },
              ]}
            />
          );
        },
      },
    ],
    [
      docsUrl,
      openEditDialog,
      openDeleteDialog,
      getKeyUsage,
      azureOpenAiEntraIdEnabled,
      anthropicWifEnabled,
      currentUserId,
    ],
  );

  return (
    <PageLayout
      title="Model Providers"
      description="Connect credentials for the LLM providers used in Chat and the LLM Proxy."
      tabs={MODEL_NAV_TABS}
      actionButton={addApiKeyButton}
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchInput
            objectNamePlural="credentials"
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
            <SelectTrigger
              aria-label="Filter by provider"
              className="w-full sm:w-[240px]"
            >
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
                still stored in the database. To migrate them to the vault,
                delete them and create new ones with vault references.
              </AlertDescription>
            </Alert>
          )}

        <div data-testid={E2eTestId.ChatApiKeysTable}>
          <DataTable
            columns={columns}
            data={rows}
            getRowId={(row) => row.id}
            hideSelectedCount
            isLoading={permissionsPending || isPending}
            emptyMessage="No credentials configured"
            hasActiveFilters={Boolean(search || providerFilter !== "all")}
            filteredEmptyMessage="No LLM provider credentials match your filters. Try adjusting your search."
            onClearFilters={() =>
              updateQueryParams({
                search: null,
                provider: null,
              })
            }
          />
        </div>

        {/* Create Dialog */}
        <CreateLlmProviderApiKeyDialog
          open={isCreateDialogOpen}
          onOpenChange={setIsCreateDialogOpen}
          title="Add API Key"
          description="Add a new LLM provider API key for use in Chat and LLM Proxy"
        />
        {subscriptionToConnect && (
          <CreateLlmProviderApiKeyDialog
            open
            onOpenChange={(open) => {
              if (!open) setSubscriptionToConnect(null);
            }}
            title={`Sign in with ${subscriptionToConnect.name}`}
            description={`Connect your ${subscriptionToConnect.name} subscription`}
            defaultValues={subscriptionToConnect.defaultValues}
            allowedProviders={[subscriptionToConnect.provider]}
            credentialMode="subscription"
          />
        )}

        {/* Edit Dialog */}
        <FormDialog
          open={!!editingApiKey}
          onOpenChange={(open) => {
            if (!open) closeEditDialog();
          }}
          title="Edit API Key"
          description="Update the name, API key value, or scope"
          size="small"
          className="sm:max-w-xl"
          isDirty={editForm.formState.isDirty}
        >
          <DialogForm
            onSubmit={handleEdit}
            className="flex min-h-0 flex-1 flex-col"
          >
            <DialogBody>
              {editingApiKey && (
                <LlmProviderApiKeyForm
                  mode="full"
                  showConsoleLink={false}
                  existingKey={editingApiKey}
                  existingKeys={apiKeys}
                  form={editForm}
                  isPending={updateMutation.isPending}
                />
              )}
            </DialogBody>
            <DialogStickyFooter className="mt-0">
              <DialogCancelButton>Cancel</DialogCancelButton>
              <Button
                type="submit"
                disabled={!isEditValid || updateMutation.isPending}
              >
                {updateMutation.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                <span>Test & Save</span>
              </Button>
            </DialogStickyFooter>
          </DialogForm>
        </FormDialog>

        {/* Delete Confirmation Dialog */}
        <DeleteConfirmDialog
          open={isDeleteDialogOpen}
          onOpenChange={setIsDeleteDialogOpen}
          title="Delete API Key"
          description={
            <DeleteApiKeyDescription
              apiKey={selectedApiKey}
              virtualKeys={blockingVirtualKeys?.data ?? []}
              totalVirtualKeys={blockingVirtualKeys?.pagination.total ?? 0}
              oauthClients={blockingOauthClients}
              isLoading={isLoadingVirtualKeys || isLoadingOauthClients}
            />
          }
          isPending={deleteMutation.isPending}
          onConfirm={handleDelete}
          confirmDisabled={
            isLoadingVirtualKeys ||
            isLoadingOauthClients ||
            (blockingVirtualKeys?.pagination.total ?? 0) > 0 ||
            blockingOauthClients.length > 0
          }
          confirmLabel="Delete API Key"
          pendingLabel="Deleting..."
        />
      </div>
    </PageLayout>
  );
}

function DeleteApiKeyDescription({
  apiKey,
  virtualKeys,
  totalVirtualKeys,
  oauthClients,
  isLoading,
}: {
  apiKey: LlmProviderApiKeyResponse | null;
  virtualKeys: archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"];
  totalVirtualKeys: number;
  oauthClients: archestraApiTypes.GetLlmOauthClientsResponses["200"];
  isLoading: boolean;
}) {
  if (!apiKey) {
    return null;
  }

  const hasBlockingAssociations =
    totalVirtualKeys > 0 || oauthClients.length > 0;

  if (!hasBlockingAssociations) {
    return (
      <span>
        Are you sure you want to delete "{apiKey.name}"? This action cannot be
        undone.
      </span>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      <p>
        "{apiKey.name}" cannot be deleted until it is removed from the
        credentials below.
      </p>

      {isLoading && (
        <p className="text-muted-foreground">Checking credential mappings...</p>
      )}

      {totalVirtualKeys > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium">Virtual API keys</p>
            <Link
              className="text-primary underline-offset-4 hover:underline"
              href="/llm/proxies"
            >
              View all
            </Link>
          </div>
          <ul className="space-y-2">
            {virtualKeys.slice(0, 5).map((key) => (
              <li
                key={key.id}
                className="rounded-md border bg-muted/30 px-3 py-2"
              >
                <div className="font-medium">{key.name}</div>
                <div className="text-muted-foreground">
                  Token starts with {key.tokenStart}...
                </div>
              </li>
            ))}
          </ul>
          {totalVirtualKeys > virtualKeys.length && (
            <p className="text-muted-foreground">
              <span>
                {totalVirtualKeys - virtualKeys.length} more virtual API key
              </span>
              {totalVirtualKeys - virtualKeys.length === 1 ? null : (
                <span>s</span>
              )}
              <span> matched.</span>
            </p>
          )}
        </div>
      )}

      {oauthClients.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium">OAuth clients</p>
            <Link
              className="text-primary underline-offset-4 hover:underline"
              href="/llm/proxies"
            >
              View all
            </Link>
          </div>
          <ul className="space-y-2">
            {oauthClients.slice(0, 5).map((client) => (
              <li
                key={client.id}
                className="rounded-md border bg-muted/30 px-3 py-2"
              >
                <div className="font-medium">{client.name}</div>
                <div className="break-all text-muted-foreground">
                  {client.clientId}
                </div>
              </li>
            ))}
          </ul>
          {oauthClients.length > 5 && (
            <p className="text-muted-foreground">
              <span>{oauthClients.length - 5} more OAuth client</span>
              {oauthClients.length - 5 === 1 ? null : <span>s</span>}
              <span> matched.</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
