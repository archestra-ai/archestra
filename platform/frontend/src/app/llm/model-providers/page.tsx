"use client";

import {
  type archestraApiTypes,
  E2eTestId,
  formatSecretStorageType,
  isProviderApiKeyOptional,
  SUBSCRIPTION_CREDENTIALS,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  Boxes,
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
import {
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
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
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
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
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useFeature } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmOauthClients } from "@/lib/llm-oauth-clients.query";
import {
  useBulkDeleteLlmProviderApiKeys,
  useDeleteLlmProviderApiKey,
  useLlmProviderApiKey,
  useLlmProviderApiKeys,
  useUpdateLlmProviderApiKey,
} from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";
import { MODEL_NAV_TABS } from "../model-nav-tabs";
import {
  buildSubscriptionOffers,
  type SubscriptionOffer,
  subscriptionKindOfCredential,
} from "./_parts/subscription-offers";
import { SubscriptionProviderCards } from "./_parts/subscription-provider-cards";
import {
  isEditApiKeyFormValid,
  subscriptionSignInRequired,
} from "./edit-key-form.utils";

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
  authMethod: "api-key",
};

export default function ApiKeysPage() {
  const docsUrl = getFrontendDocsUrl("platform-supported-llm-providers");
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const search = searchParams.get("search") || "";
  const providerFilter = searchParams.get("provider") || "all";
  const { data: canReadLlmProviderApiKeys, isPending: permissionsPending } =
    useHasPermissions({ llmProviderApiKey: ["read"] });
  const apiKeyQueriesEnabled =
    !permissionsPending && canReadLlmProviderApiKeys === true;
  const { data: allApiKeys = [], isPending: allApiKeysPending } =
    useLlmProviderApiKeys({
      enabled: apiKeyQueriesEnabled,
    });
  const { data: queriedApiKeys = [], isFetching } = useLlmProviderApiKeys({
    search: search || undefined,
    provider:
      providerFilter === "all"
        ? undefined
        : (providerFilter as LlmProviderApiKeyResponse["provider"]),
    enabled: apiKeyQueriesEnabled,
  });
  const { data: organization } = useOrganization();
  const providerCatalog = useModelProviderCatalog();
  // Read defensively: suites that render this page mock the auth query module
  // wholesale, and the Access column should fall back to the scope label
  // rather than crash the table (same convention as `user-share-field.tsx`).
  const currentUserId = useSession()?.data?.user?.id;
  const updateMutation = useUpdateLlmProviderApiKey();
  const deleteMutation = useDeleteLlmProviderApiKey();
  const bulkDeleteMutation = useBulkDeleteLlmProviderApiKeys();
  const byosEnabled = useFeature("byosEnabled");
  const azureOpenAiEntraIdEnabled = useFeature("azureOpenAiEntraIdEnabled");
  const anthropicWifEnabled = useFeature("anthropicWifEnabled");

  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [subscriptionToConnect, setSubscriptionToConnect] =
    useState<SubscriptionOffer | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false);
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
  const { data: blockingOauthClientsData, isPending: isLoadingOauthClients } =
    useLlmOauthClients({
      providerApiKeyId: selectedApiKeyId ?? undefined,
      limit: 100,
      offset: 0,
      enabled: !!selectedApiKeyId && isDeleteDialogOpen,
    });
  const blockingOauthClients = blockingOauthClientsData?.data ?? [];
  // A subscription is connected, not configured, so the dialog that removes it
  // says "disconnect" rather than talking about deleting an API key.
  const deletingSubscription =
    selectedApiKey !== null &&
    subscriptionKindOfCredential(selectedApiKey) !== null;

  const getKeyUsage = useCallback(
    (keyId: string): string | null => {
      if (!organization) return null;
      const usages: string[] = [];
      if (organization.embeddingChatApiKeyId === keyId)
        usages.push("embedding");
      if (organization.rerankerChatApiKeyId === keyId) usages.push("reranking");
      if (organization.ocrChatApiKeyId === keyId) usages.push("OCR");
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
        // Open on the auth-mode tab that matches the stored credential:
        // subscription keys land on the subscription tab, plain keys on API Key.
        authMethod: editingApiKey.subscriptionKind ? "subscription" : "api-key",
      });
    }
  }, [editingApiKey, editForm]);

  const handleEdit = editForm.handleSubmit(async (values) => {
    if (!editingApiKey) return;
    // Defense in depth behind the disabled Save button: a subscription tab on a
    // key that doesn't hold that subscription must not submit without a
    // completed sign-in — the update would privatize a shared key while
    // keeping its old shared secret.
    if (subscriptionSignInRequired(values, editingApiKey)) return;

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
      (blockingOauthClientsData?.pagination.total ?? 0) > 0;
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
    blockingOauthClientsData,
    deleteMutation,
  ]);

  const openDeleteDialog = useCallback((apiKey: LlmProviderApiKeyResponse) => {
    setSelectedApiKey(apiKey);
    setIsDeleteDialogOpen(true);
  }, []);

  // Validation for edit form
  const editFormValues = editForm.watch();
  const isEditValid = isEditApiKeyFormValid(
    editFormValues,
    editingApiKey ?? undefined,
  );

  const addApiKeyButton = (
    <div className="flex items-center gap-2">
      <Button
        onClick={() => setIsCreateDialogOpen(true)}
        data-testid={E2eTestId.AddChatApiKeyButton}
      >
        <Plus className="h-4 w-4" />
        <span>Add API Key</span>
      </Button>
    </div>
  );

  const apiKeys = queriedApiKeys;

  /**
   * Subscription offers shown as cards above the table. A provider the admins
   * turned off is not offered at all; a key that already connects it keeps its
   * table row instead, so an admin can still see and delete it.
   */
  const subscriptionOffers = useMemo(
    () =>
      buildSubscriptionOffers(allApiKeys).filter(
        ({ provider }) => !providerCatalog.isHidden(provider),
      ),
    [allApiKeys, providerCatalog],
  );

  /** Keys the cards already stand for, so the table never repeats them. */
  const connectedSubscriptionIds = useMemo(
    () =>
      new Set(
        subscriptionOffers.flatMap(({ credential }) =>
          credential ? [credential.id] : [],
        ),
      ),
    [subscriptionOffers],
  );

  const rows = useMemo(
    () => queriedApiKeys.filter(({ id }) => !connectedSubscriptionIds.has(id)),
    [queriedApiKeys, connectedSubscriptionIds],
  );

  // The filter narrows the table, so it offers the providers the table can
  // actually show — a connected subscription lives on a card, not a row.
  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    return allApiKeys
      .filter((apiKey) => {
        if (connectedSubscriptionIds.has(apiKey.id)) return false;
        if (seen.has(apiKey.provider)) return false;
        seen.add(apiKey.provider);
        return true;
      })
      .map((apiKey) => ({
        value: apiKey.provider,
        icon: PROVIDER_CONFIG[apiKey.provider].icon,
        name: providerCatalog.label(apiKey.provider),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allApiKeys, connectedSubscriptionIds, providerCatalog]);

  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected,
    selectAllMatching,
  } = useBulkSelection({
    rows,
    getId: (row) => row.id,
    canSelect: (row) => !row.isSystem && getKeyUsage(row.id) === null,
    filterSignature: `${search}\u0000${providerFilter}`,
    matchDescription:
      search || providerFilter !== "all"
        ? "match the current filters"
        : "are configured",
  });
  const selectedApiKeys = selected;

  const columns: ColumnDef<LlmProviderApiKeyResponse>[] = useMemo(
    () => [
      createSelectColumn<LlmProviderApiKeyResponse>({
        rowLabel: (row) => `Select ${row.name}`,
        allLabel: "Select all deletable credentials on this page",
        canSelect: (row) => !row.isSystem && getKeyUsage(row.id) === null,
        disabledReason: (row) => {
          if (row.isSystem) return "System keys cannot be deleted";
          const usage = getKeyUsage(row.id);
          return usage
            ? `${usage}. Remove it from Settings > Knowledge before deleting.`
            : "Unavailable for bulk actions";
        },
      }),
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
          const provider = row.original.provider;
          const label = providerCatalog.label(provider);
          return (
            <div className="flex min-w-0 items-center gap-2">
              <Image
                src={PROVIDER_CONFIG[provider].icon}
                alt={label}
                width={20}
                height={20}
                className="rounded dark:invert"
              />
              <span className="truncate">{label}</span>
              {providerCatalog.isHidden(provider) && (
                <InlineTag className="shrink-0">Turned off</InlineTag>
              )}
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
          row.original.isSystem ? (
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
            {row.original.isSystem ||
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
          const credential = row.original;
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
      providerCatalog,
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
        <SubscriptionProviderCards
          offers={subscriptionOffers}
          // A viewer without key-read permission never gets a list, so their
          // cards state the offer rather than waiting forever on a query that
          // is disabled — connecting a personal subscription is self-service.
          isLoading={
            permissionsPending || (apiKeyQueriesEnabled && allApiKeysPending)
          }
          onConnect={setSubscriptionToConnect}
          onManage={openEditDialog}
          onDisconnect={openDeleteDialog}
          disconnectBlockedReason={(credential) => {
            const usage = getKeyUsage(credential.id);
            return usage
              ? `${usage}. Remove it from Settings > Knowledge before disconnecting.`
              : null;
          }}
        />

        <div className="space-y-1 pt-1">
          <h2 className="text-sm font-medium">Provider API keys</h2>
          <p className="text-sm text-muted-foreground">
            Keys for the providers that authenticate with an API key, shared
            across the organization or kept to a team or person.
          </p>
        </div>

        <FilterBar className="!mb-3">
          <SearchInput
            isLoading={isFetching}
            objectNamePlural="credentials"
            searchFields={["name"]}
            paramName="search"
            className={filterSearchClass}
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
              size="sm"
              aria-label="Filter by provider"
              className={filterControlClass({
                active: providerFilter !== "all",
              })}
            >
              <SelectValue placeholder="All providers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All providers</SelectItem>
              <LlmProviderSelectItems options={providerOptions} />
            </SelectContent>
          </Select>
        </FilterBar>

        {byosEnabled &&
          apiKeys.some((key) => key.secretStorageType === "database") && (
            <Alert variant="destructive" className="!mb-3">
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
          <BulkActions
            count={selectedApiKeys.length}
            noun="API key"
            onClear={clearSelection}
            busy={bulkDeleteMutation.isPending}
            selectAllMatching={selectAllMatching}
          >
            <PermissionButton
              permissions={{ llmProviderApiKey: ["delete"] }}
              variant="destructive"
              size="sm"
              onClick={() => setIsBulkDeleteDialogOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
              <span>Delete</span>
            </PermissionButton>
          </BulkActions>
          <DataTable
            columns={columns}
            data={rows}
            getRowId={(row) => row.id}
            rowSelection={rowSelection}
            onRowSelectionChange={setRowSelection}
            onPageRowIdsChange={onPageRowIdsChange}
            hideSelectedCount
            isLoading={permissionsPending || isFetching}
            emptyIcon={Boxes}
            emptyMessage="No credentials configured"
            hasActiveFilters={Boolean(search || providerFilter !== "all")}
            filteredEmptyMessage="No LLM provider credentials match your filters"
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
            title={
              SUBSCRIPTION_CREDENTIALS[subscriptionToConnect.kind].connect
                .signInTitle
            }
            description={
              SUBSCRIPTION_CREDENTIALS[subscriptionToConnect.kind].connect
                .signInDescription
            }
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
          title={
            deletingSubscription ? "Disconnect subscription" : "Delete API Key"
          }
          description={
            <DeleteApiKeyDescription
              apiKey={selectedApiKey}
              isSubscription={deletingSubscription}
              virtualKeys={blockingVirtualKeys?.data ?? []}
              totalVirtualKeys={blockingVirtualKeys?.pagination.total ?? 0}
              oauthClients={blockingOauthClients}
              totalOauthClients={
                blockingOauthClientsData?.pagination.total ?? 0
              }
              isLoading={isLoadingVirtualKeys || isLoadingOauthClients}
            />
          }
          isPending={deleteMutation.isPending}
          onConfirm={handleDelete}
          confirmDisabled={
            isLoadingVirtualKeys ||
            isLoadingOauthClients ||
            (blockingVirtualKeys?.pagination.total ?? 0) > 0 ||
            (blockingOauthClientsData?.pagination.total ?? 0) > 0
          }
          confirmLabel={deletingSubscription ? "Disconnect" : "Delete API Key"}
          pendingLabel={
            deletingSubscription ? "Disconnecting..." : "Deleting..."
          }
        />
        <DeleteConfirmDialog
          open={isBulkDeleteDialogOpen}
          onOpenChange={setIsBulkDeleteDialogOpen}
          title="Delete API keys"
          description={`Delete ${selectedApiKeys.length} ${
            selectedApiKeys.length === 1 ? "API key" : "API keys"
          }? This cannot be undone.`}
          isPending={bulkDeleteMutation.isPending}
          onConfirm={() => {
            bulkDeleteMutation.mutate(selectedApiKeys, {
              onSuccess: (outcome) => {
                reportBulkOutcome({
                  outcome,
                  verb: "Deleted",
                  failureVerb: "delete",
                  noun: "API key",
                });
                setIsBulkDeleteDialogOpen(false);
                if (outcome.failed.length === 0) clearSelection();
              },
            });
          }}
          confirmLabel="Delete API keys"
          pendingLabel="Deleting..."
        />
      </div>
    </PageLayout>
  );
}

function DeleteApiKeyDescription({
  apiKey,
  isSubscription,
  virtualKeys,
  totalVirtualKeys,
  oauthClients,
  totalOauthClients,
  isLoading,
}: {
  apiKey: LlmProviderApiKeyResponse | null;
  isSubscription: boolean;
  virtualKeys: archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"];
  totalVirtualKeys: number;
  oauthClients: archestraApiTypes.GetLlmOauthClientsResponses["200"]["data"];
  totalOauthClients: number;
  isLoading: boolean;
}) {
  if (!apiKey) {
    return null;
  }

  const hasBlockingAssociations = totalVirtualKeys > 0 || totalOauthClients > 0;

  if (!hasBlockingAssociations) {
    // Distinct keys: the two branches share a tag, so without them React would
    // reconcile the element in place and remove its bare text nodes, which
    // crashes a machine-translated page.
    return isSubscription ? (
      <span key="disconnect">
        Disconnect "{apiKey.name}"? Anything using it stops working until you
        sign in again.
      </span>
    ) : (
      <span key="delete">
        Are you sure you want to delete "{apiKey.name}"? This action cannot be
        undone.
      </span>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      <p>
        "{apiKey.name}" cannot be {isSubscription ? "disconnected" : "deleted"}{" "}
        until it is removed from the credentials below.
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
              href={`/llm/proxy/virtual-keys?providerApiKeyId=${apiKey.id}`}
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
              href={`/llm/proxy/oauth-clients?providerApiKeyId=${apiKey.id}`}
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
          {totalOauthClients > 5 && (
            <p className="text-muted-foreground">
              <span>{totalOauthClients - 5} more OAuth client</span>
              {totalOauthClients - 5 === 1 ? null : <span>s</span>}
              <span> matched.</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
