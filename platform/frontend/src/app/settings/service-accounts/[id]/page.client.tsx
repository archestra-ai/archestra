"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  KeyRound,
  ListFilter,
  Loader2,
  Plus,
  Power,
  PowerOff,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { CopyableCode } from "@/components/copyable-code";
import { createdByFact } from "@/components/created-by-cell";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailFacts, presentFacts } from "@/components/detail-facts";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { FormDialog } from "@/components/form-dialog";
import { LoadingWrapper } from "@/components/loading";
import { PageBackLink } from "@/components/page-back-link";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { SearchInput } from "@/components/search-input";
import {
  AccountHealthBadge,
  KeyStatusBadge,
} from "@/components/service-account-status-badge";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { RoleSelect } from "@/components/ui/role-select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  type ServiceAccountToken,
  useBulkServiceAccountTokenAction,
  useCreateServiceAccountToken,
  useDeleteServiceAccountToken,
  useServiceAccount,
  useUpdateServiceAccount,
  useUpdateServiceAccountToken,
} from "@/lib/service-account.query";
import {
  canAuthenticate,
  daysUntil,
  describeAccountHealth,
  getAccountHealth,
  getKeyStatus,
  KEY_STATUS_LABELS,
  type KeyStatus,
} from "@/lib/service-account-status";
import {
  formatRelativeTime,
  formatRelativeTimeFromNow,
} from "@/lib/utils/date-time";
import { formatRoleName } from "@/lib/utils/role";
import { useSetSettingsAction, useSetSettingsPageHeader } from "../../layout";

type TokenFormValues = {
  name: string;
  expiresAt: Date | null;
};

const DEFAULT_TOKEN_FORM_VALUES: TokenFormValues = {
  name: "",
  expiresAt: null,
};

/**
 * Placeholder standing in for a real key in the example request. Angle
 * brackets rather than the `arch_` prefix a real key carries: it reads as a
 * slot to fill, and a command pasted unedited fails loudly instead of looking
 * like it carries a working credential.
 */
const EXAMPLE_KEY = "<YOUR_KEY>";

/**
 * The record's facets, in bar order. Overview is first and so is the tab an
 * unrecognised `?tab=` falls back to.
 *
 * A third facet, Permissions, belongs here once scoped grants reach service
 * accounts: add the id, its label, and a branch in the content switch.
 */
const TAB_IDS = ["overview", "keys"] as const;
type DetailTab = (typeof TAB_IDS)[number];

const TAB_LABELS: Record<DetailTab, string> = {
  overview: "Overview",
  keys: "API keys",
};

/** Sentinel for "no filter", matching the service accounts list beside it. */
const ALL = "all";

/** Offered in severity order, the order the statuses are derived in. */
const KEY_STATUS_FILTERS: KeyStatus[] = [
  "expired",
  "expiring",
  "active",
  "disabled",
];

export default function ServiceAccountDetailPage({
  serviceAccountId,
}: {
  serviceAccountId: string;
}) {
  const setActionButton = useSetSettingsAction();
  const setPageHeader = useSetSettingsPageHeader();
  const { searchParams, pathname, updateQueryParams } =
    useDataTableQueryParams();
  const { data: canReadServiceAccounts, isPending: isCheckingPermissions } =
    useHasPermissions({ serviceAccount: ["read"] });
  const { data: canUpdateServiceAccounts } = useHasPermissions({
    serviceAccount: ["update"],
  });
  const {
    data: serviceAccount,
    isPending,
    isFetching,
    isLoadingError,
    refetch,
  } = useServiceAccount(serviceAccountId);
  const updateMutation = useUpdateServiceAccount();
  const createTokenMutation = useCreateServiceAccountToken();
  const updateTokenMutation = useUpdateServiceAccountToken();
  const deleteTokenMutation = useDeleteServiceAccountToken();
  const bulkTokenAction = useBulkServiceAccountTokenAction();

  const [selectedRole, setSelectedRole] = useState("member");
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const [isTokenDialogOpen, setIsTokenDialogOpen] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<ServiceAccountToken | null>(
    null,
  );
  const [bulkRevokeOpen, setBulkRevokeOpen] = useState(false);

  const form = useForm<{ name: string }>({ defaultValues: { name: "" } });
  const apiDocsUrl = getFrontendDocsUrl("platform-api-reference");
  const tokenForm = useForm<TokenFormValues>({
    defaultValues: DEFAULT_TOKEN_FORM_VALUES,
  });

  const tokens = useMemo(
    () => serviceAccount?.tokens ?? [],
    [serviceAccount?.tokens],
  );
  const health = serviceAccount ? getAccountHealth(serviceAccount) : null;

  const tabParam = searchParams.get("tab");
  const activeTab: DetailTab = TAB_IDS.includes(tabParam as DetailTab)
    ? (tabParam as DetailTab)
    : "overview";

  const search = searchParams.get("search") || "";
  const statusFilter = searchParams.get("status") || ALL;
  const hasActiveFilters = search.trim().length > 0 || statusFilter !== ALL;

  const clearFilters = useCallback(
    () => updateQueryParams({ search: null, status: null, page: "1" }),
    [updateQueryParams],
  );

  const filteredTokens = useMemo(() => {
    const query = search.trim().toLowerCase();
    const now = new Date();

    return tokens.filter((token) => {
      if (query && !token.name.toLowerCase().includes(query)) return false;
      if (statusFilter !== ALL && getKeyStatus(token, now) !== statusFilter) {
        return false;
      }
      return true;
    });
  }, [tokens, search, statusFilter]);

  // The tab bar is a row of links, so the URL owns the selection. The key
  // table's own state is scoped to its tab: carried while you stay on it, and
  // dropped on the way out so it cannot come back on a later visit.
  const tabHref = useCallback(
    (tab: DetailTab) => {
      const params = new URLSearchParams(searchParams.toString());
      if (tab === "overview") {
        params.delete("tab");
      } else {
        params.set("tab", tab);
      }
      if (tab !== "keys") {
        params.delete("search");
        params.delete("status");
        params.delete("page");
        params.delete("pageSize");
      }
      const queryString = params.toString();
      return queryString ? `${pathname}?${queryString}` : pathname;
    },
    [pathname, searchParams],
  );

  const tabs = useMemo(
    () =>
      TAB_IDS.map((tab) => ({
        label: TAB_LABELS[tab],
        href: tabHref(tab),
        testId: `service-account-tab-${tab}`,
        // Selection lives in a query param, which `PageLayout` cannot read
        // from an href alone.
        selected: tab === activeTab,
      })),
    [activeTab, tabHref],
  );

  const openTokenDialog = useCallback(() => {
    tokenForm.reset({
      name: serviceAccount ? `${serviceAccount.name} key` : "",
      expiresAt: null,
    });
    setIsTokenDialogOpen(true);
  }, [serviceAccount, tokenForm]);

  const setDisabled = updateMutation.mutate;
  const toggleAccountDisabled = useCallback(() => {
    if (!serviceAccount) return;
    setDisabled({
      id: serviceAccountId,
      body: { disabled: !serviceAccount.disabled },
    });
  }, [serviceAccount, serviceAccountId, setDisabled]);

  useEffect(() => {
    setActionButton(
      <div className="flex items-center gap-2">
        {serviceAccount && canUpdateServiceAccounts && (
          <Button
            type="button"
            variant="outline"
            onClick={toggleAccountDisabled}
            disabled={updateMutation.isPending}
          >
            {serviceAccount.disabled ? (
              <Power className="h-4 w-4" />
            ) : (
              <PowerOff className="h-4 w-4" />
            )}
            {serviceAccount.disabled ? "Enable" : "Disable"}
          </Button>
        )}
        <PermissionButton
          permissions={{ serviceAccount: ["update"] }}
          type="button"
          onClick={openTokenDialog}
        >
          <Plus className="h-4 w-4" />
          Create API key
        </PermissionButton>
      </div>,
    );

    return () => setActionButton(null);
  }, [
    canUpdateServiceAccounts,
    openTokenDialog,
    serviceAccount,
    setActionButton,
    toggleAccountDisabled,
    updateMutation.isPending,
  ]);

  // The settings shell derives its header from the pathname, so without this
  // the page would be titled "Service Accounts" and never name the account
  // you are actually looking at.
  useEffect(() => {
    if (!serviceAccount || !health) return;

    setPageHeader({
      title: serviceAccount.name,
      documentTitle: serviceAccount.name,
      status: <AccountHealthBadge health={health} />,
      tabs,
      backLink: (
        <PageBackLink href="/settings/service-accounts">
          Back to service accounts
        </PageBackLink>
      ),
    });

    return () => setPageHeader(null);
  }, [health, serviceAccount, setPageHeader, tabs]);

  useEffect(() => {
    if (!serviceAccount) return;

    form.reset({ name: serviceAccount.name });
    setSelectedRole(serviceAccount.role);
    setLabels(serviceAccount.labels);
  }, [form, serviceAccount]);

  const watchedName = form.watch("name");
  const hasChanges =
    !!serviceAccount &&
    (watchedName !== serviceAccount.name ||
      selectedRole !== serviceAccount.role ||
      JSON.stringify(labels) !== JSON.stringify(serviceAccount.labels));

  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected: selectedTokens,
  } = useBulkSelection({
    rows: filteredTokens,
    getId: (token) => token.id,
    filterSignature: `${serviceAccountId}|${search}|${statusFilter}`,
  });

  const columns: ColumnDef<ServiceAccountToken>[] = useMemo(
    () => [
      ...(canUpdateServiceAccounts
        ? [
            createSelectColumn<ServiceAccountToken>({
              rowLabel: (token) => `Select ${token.name}`,
              allLabel: "Select all API keys on this page",
            }),
          ]
        : []),
      {
        accessorKey: "name",
        header: "Name",
        size: 114,
        cell: ({ row }) => (
          <div className="truncate font-medium" title={row.original.name}>
            {row.original.name}
          </div>
        ),
      },
      {
        accessorKey: "tokenStart",
        header: "Key",
        size: 196,
        cell: ({ row }) => (
          // The prefix is the only part of a key that is ever shown again, and
          // it is how you match a key here against one in a CI secret store,
          // so it needs to be copyable rather than selectable-by-hand.
          // `whitespace-nowrap` because a prefix broken across two lines is
          // both unreadable and enough to double the height of every row.
          <CopyableCode
            value={row.original.tokenStart}
            toastMessage="Key prefix copied"
            className="w-fit gap-1 whitespace-nowrap px-2 py-1 text-xs"
          />
        ),
      },
      {
        // Status and expiry are one column: the badge is the verdict and the
        // date is its reason, and as separate columns they did not fit the
        // settings shell's width. A key's creation date is dropped for the
        // same reason - for a credential, when it stops working matters more
        // than when it started.
        accessorKey: "disabled",
        header: "Status",
        size: 112,
        cell: ({ row }) => (
          // The badge alone, with the date it is derived from on hover. Six
          // columns do not fit the settings shell's content width, and
          // spelling the date out inline was the 16px that pushed Actions off
          // the edge. The badge is the part you scan; the date is the part
          // you check once, on the one row that is amber.
          <span title={expiryTitle(row.original)}>
            <KeyStatusBadge status={getKeyStatus(row.original)} />
          </span>
        ),
      },
      {
        accessorKey: "lastUsedAt",
        header: "Last used",
        size: 104,
        cell: ({ row }) =>
          row.original.lastUsedAt ? (
            formatRelativeTimeFromNow(row.original.lastUsedAt)
          ) : (
            <span className="text-muted-foreground">Never used</span>
          ),
      },
      ...(canUpdateServiceAccounts
        ? [
            {
              id: "actions",
              header: "Actions",
              size: 84,
              cell: ({ row }) => (
                // In a menu rather than as a row of icon buttons. Inline, the
                // revoke button put a destructive red glyph on every row, so
                // the loudest thing in the table was an action nobody came
                // here to take.
                <TableRowActions
                  itemName={row.original.name}
                  actions={[]}
                  dropdownActions={[
                    {
                      icon: row.original.disabled ? (
                        <Power className="h-4 w-4" />
                      ) : (
                        <PowerOff className="h-4 w-4" />
                      ),
                      label: row.original.disabled
                        ? "Activate API key"
                        : "Deactivate API key",
                      onClick: () =>
                        updateTokenMutation.mutate({
                          id: serviceAccountId,
                          tokenId: row.original.id,
                          body: { disabled: !row.original.disabled },
                        }),
                    },
                    {
                      icon: <Trash2 className="h-4 w-4" />,
                      label: "Revoke API key",
                      onClick: () => setKeyToDelete(row.original),
                      variant: "destructive" as const,
                    },
                  ]}
                />
              ),
            } satisfies ColumnDef<ServiceAccountToken>,
          ]
        : []),
    ],
    [canUpdateServiceAccounts, serviceAccountId, updateTokenMutation],
  );

  const handleDeleteKey = async () => {
    if (!keyToDelete) return;
    await deleteTokenMutation.mutateAsync({
      id: serviceAccountId,
      tokenId: keyToDelete.id,
    });
    setKeyToDelete(null);
  };

  const runTokenBulk = (
    action: { type: "delete" } | { type: "setDisabled"; disabled: boolean },
    labels: { verb: string; failureVerb: string },
  ) =>
    bulkTokenAction.mutate(
      { id: serviceAccountId, tokens: selectedTokens, action },
      {
        onSuccess: (outcome) => {
          reportBulkOutcome({ outcome, ...labels, noun: "API key" });
          setBulkRevokeOpen(false);
          if (outcome.failed.length === 0) clearSelection();
        },
      },
    );

  const handleSave = async () => {
    if (!serviceAccount || !watchedName.trim()) return;
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;

    await updateMutation.mutateAsync({
      id: serviceAccountId,
      body: {
        name: watchedName.trim(),
        role: selectedRole,
        labels: finalLabels,
      },
    });
  };

  const handleCancel = () => {
    if (!serviceAccount) return;

    form.reset({ name: serviceAccount.name });
    setSelectedRole(serviceAccount.role);
    setLabels(serviceAccount.labels);
  };

  const handleCreateToken = tokenForm.handleSubmit(async (values) => {
    const expiresIn = values.expiresAt
      ? Math.max(
          1,
          Math.floor((values.expiresAt.getTime() - Date.now()) / 1000),
        )
      : null;
    const token = await createTokenMutation.mutateAsync({
      id: serviceAccountId,
      body: { name: values.name.trim(), expiresIn },
    });
    if (!token?.token) return;

    setIsTokenDialogOpen(false);
    setCreatedToken(token.token);
    tokenForm.reset(DEFAULT_TOKEN_FORM_VALUES);
  });

  if (!isCheckingPermissions && !canReadServiceAccounts) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Access denied</AlertTitle>
        <AlertDescription>
          You do not have permission to view service accounts.
        </AlertDescription>
      </Alert>
    );
  }

  const healthExplanation = health ? describeAccountHealth(health) : null;

  return (
    <LoadingWrapper
      isPending={(isPending || isFetching) && !serviceAccount}
      loadingFallback={null}
    >
      {isLoadingError ? (
        <QueryLoadError
          title="Couldn't load this service account"
          onRetry={() => refetch()}
        />
      ) : !serviceAccount || !health ? (
        <Alert variant="destructive">
          <AlertTitle>Service account not found</AlertTitle>
          <AlertDescription>
            This service account may have been deleted.
          </AlertDescription>
        </Alert>
      ) : (
        <SettingsSectionStack>
          {/* Only when something is actually wrong. A banner that is always
              present is one nobody reads. */}
          {healthExplanation && (
            // Half the stack's gap: the notice is about the block below it.
            <div className="-mb-4">
              <InlineNotice variant="error">
                <AlertTriangle />
                <span className="font-medium">
                  This service account cannot authenticate
                </span>
                <InlineNoticeText>{healthExplanation}</InlineNoticeText>
              </InlineNotice>
            </div>
          )}

          {activeTab === "keys" ? (
            // The filter bar, the selection actions and the table are one
            // scope: at zero selection the bar is the filters, and ticking a
            // row swaps the actions into that same row rather than opening a
            // second one above the table.
            <BulkActionsScope>
              <div>
                <p className="mb-3 text-sm text-muted-foreground">
                  Keys that let scripts and integrations call the{" "}
                  {apiDocsUrl ? (
                    <ExternalDocsLink
                      href={apiDocsUrl}
                      className="text-inherit underline underline-offset-4"
                      showIcon={false}
                    >
                      platform API
                    </ExternalDocsLink>
                  ) : (
                    <span>platform API</span>
                  )}{" "}
                  as this service account.
                </p>

                {/* Above the table, with the prose that introduces the
                    section. It answers "how do I use one of these", which is
                    a question you have before you read the list, not after
                    it. */}
                {canAuthenticate(health) && (
                  <div className="mb-4 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      Authenticate a request as this service account
                    </p>
                    <CopyableCode
                      value={`curl -H "Authorization: ${EXAMPLE_KEY}" ${apiBaseUrl()}/api/config`}
                      toastMessage="Example request copied"
                      className="text-xs"
                    />
                  </div>
                )}

                <CollectionFilters>
                  <FilterBar
                    onClearFilters={hasActiveFilters ? clearFilters : undefined}
                    search={
                      <SearchInput
                        objectNamePlural="API keys"
                        searchFields={["name"]}
                        className={filterSearchClass}
                      />
                    }
                  >
                    <FilterSelect
                      value={statusFilter}
                      onValueChange={(value) =>
                        updateQueryParams({
                          status: value === ALL ? null : value,
                          page: "1",
                        })
                      }
                      placeholder="Filter by status"
                      // Each option renders as the reading it selects, so the
                      // filter teaches the same vocabulary the Status column
                      // uses instead of a second, plainer one. `label` stays
                      // the bare word, which is what the option list is
                      // searched and announced by.
                      items={[
                        {
                          value: ALL,
                          label: "All statuses",
                          content: (
                            <span className="inline-flex items-center gap-1.5 text-sm">
                              <ListFilter
                                aria-hidden
                                className="size-3.5 shrink-0 text-muted-foreground"
                              />
                              All statuses
                            </span>
                          ),
                        },
                        ...KEY_STATUS_FILTERS.map((status) => ({
                          value: status,
                          label: KEY_STATUS_LABELS[status],
                          content: <KeyStatusBadge status={status} />,
                        })),
                      ]}
                    />
                  </FilterBar>
                </CollectionFilters>

                {canUpdateServiceAccounts && (
                  <BulkActions
                    count={selectedTokens.length}
                    noun="API key"
                    onClear={clearSelection}
                    busy={bulkTokenAction.isPending}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        runTokenBulk(
                          { type: "setDisabled", disabled: false },
                          { verb: "Activated", failureVerb: "activate" },
                        )
                      }
                    >
                      <Power className="h-4 w-4" />
                      <span>Activate</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        runTokenBulk(
                          { type: "setDisabled", disabled: true },
                          { verb: "Deactivated", failureVerb: "deactivate" },
                        )
                      }
                    >
                      <PowerOff className="h-4 w-4" />
                      <span>Deactivate</span>
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setBulkRevokeOpen(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span>Revoke</span>
                    </Button>
                  </BulkActions>
                )}

                <DataTable
                  columns={columns}
                  data={filteredTokens}
                  getRowId={(row) => row.id}
                  rowSelection={rowSelection}
                  onRowSelectionChange={setRowSelection}
                  onPageRowIdsChange={onPageRowIdsChange}
                  hideSelectedCount
                  emptyIcon={KeyRound}
                  emptyMessage="No API keys yet"
                  emptyDescription="Without a key this service account cannot authenticate. Create one to start using it."
                  hasActiveFilters={hasActiveFilters}
                  filteredEmptyMessage="No API keys match your filters"
                  onClearFilters={clearFilters}
                  hidePaginationWhenSinglePage
                  // `DataTable` sets the table's `min-width` to the sum of
                  // these sizes, and the settings shell gives the content
                  // column about 686px once the section list takes its 220px.
                  // These sum to 588 plus the select column, which leaves the
                  // flexible Name column real room at a laptop width instead
                  // of pushing Actions off the right edge.
                  fixedWidthColumnIds={[
                    "tokenStart",
                    "disabled",
                    "lastUsedAt",
                    "actions",
                  ]}
                  flexibleColumnIds={["name"]}
                />
              </div>
            </BulkActionsScope>
          ) : (
            <>
              <DetailFacts
                facts={presentFacts([
                  {
                    label: "Role",
                    value: (
                      <Badge variant="secondary">
                        {formatRoleName(serviceAccount.role)}
                      </Badge>
                    ),
                  },
                  {
                    label: "API keys",
                    value:
                      serviceAccount.tokenCount === 0
                        ? "None"
                        : serviceAccount.activeTokenCount ===
                            serviceAccount.tokenCount
                          ? `${serviceAccount.tokenCount} usable`
                          : `${serviceAccount.activeTokenCount} of ${serviceAccount.tokenCount} usable`,
                  },
                  {
                    label: "Last used",
                    value: serviceAccount.lastUsedAt
                      ? formatRelativeTimeFromNow(serviceAccount.lastUsedAt)
                      : "Never used",
                  },
                  {
                    label: "Created",
                    value: formatRelativeTimeFromNow(serviceAccount.createdAt),
                  },
                  createdByFact(serviceAccount.createdBy),
                ])}
                // No heading over it: the tab it sits on is the heading, and
                // "Overview" twice on one screen is the duplication this page
                // was reported for.
                className="rounded-lg border bg-card p-4"
              />

              <SettingsBlock
                title="Account settings"
                description="Roles set allowed actions for requests made with this account's keys. Permissions determine which resources it can reach; the Permissions section below controls access to this service account."
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="service-account-name">Display name</Label>
                    <Input
                      id="service-account-name"
                      disabled={!canUpdateServiceAccounts}
                      {...form.register("name", { required: true })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="service-account-role">Roles</Label>
                    <RoleSelect
                      multiple
                      id="service-account-role"
                      value={selectedRole}
                      onValueChange={setSelectedRole}
                      disabled={!canUpdateServiceAccounts}
                      placeholder="Select a role"
                      className="w-full"
                    />
                  </div>
                </div>
              </SettingsBlock>

              {/* SPDX-SnippetBegin */}
              {/* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */}
              {/* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
              <ResourceAccessSection
                resource="serviceAccount"
                id={serviceAccountId}
              />
              {/* SPDX-SnippetEnd */}

              {/* Labels are rarely edited, so they sit collapsed below the
                  permissions. */}
              <AdvancedLabelsSection
                ref={labelsRef}
                labels={labels}
                onLabelsChange={setLabels}
              />

              <SettingsSaveBar
                hasChanges={hasChanges}
                isSaving={updateMutation.isPending}
                permissions={{ serviceAccount: ["update"] }}
                onSave={handleSave}
                onCancel={handleCancel}
                disabledSave={!watchedName.trim()}
              />
            </>
          )}

          <CreateTokenDialog
            open={isTokenDialogOpen}
            onOpenChange={setIsTokenDialogOpen}
            form={tokenForm}
            isPending={createTokenMutation.isPending}
            onSubmit={handleCreateToken}
          />
          <CreatedTokenDialog
            token={createdToken}
            onClose={() => setCreatedToken(null)}
          />
          <DeleteConfirmDialog
            open={!!keyToDelete}
            onOpenChange={(open) => !open && setKeyToDelete(null)}
            title="Revoke API key"
            description="This will immediately revoke access for anything using this key. To stop it reversibly, deactivate it instead."
            isPending={deleteTokenMutation.isPending}
            onConfirm={handleDeleteKey}
            confirmLabel="Revoke"
            pendingLabel="Revoking..."
          />
          <DeleteConfirmDialog
            open={bulkRevokeOpen}
            onOpenChange={setBulkRevokeOpen}
            title="Revoke API keys"
            description={`Revoke ${selectedTokens.length} ${
              selectedTokens.length === 1 ? "API key" : "API keys"
            }? Anything using them stops working immediately.`}
            isPending={bulkTokenAction.isPending}
            onConfirm={() =>
              runTokenBulk(
                { type: "delete" },
                { verb: "Revoked", failureVerb: "revoke" },
              )
            }
            confirmLabel="Revoke keys"
            pendingLabel="Revoking..."
          />
        </SettingsSectionStack>
      )}
    </LoadingWrapper>
  );
}

// === Internal helpers

/**
 * What a key's status badge means, as hover text: when it lapses, or when it
 * did. Undefined for an open-ended key, so the badge carries no tooltip at all
 * rather than one saying "Never expires" on every row.
 *
 * It reads as a sentence because it is the only place the date appears. The
 * badge used to be followed by the same fact spelled out inline, which said
 * the state twice and cost the column the width that Actions needed.
 */
function expiryTitle(token: ServiceAccountToken): string | undefined {
  if (!token.expiresAt) return undefined;

  if (getKeyStatus(token) === "expired") {
    return `Expired ${formatRelativeTimeFromNow(token.expiresAt)}`;
  }

  const days = daysUntil(token.expiresAt);
  return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
}

function apiBaseUrl(): string {
  if (typeof window === "undefined") return "https://your-archestra-host";
  return window.location.origin;
}

function CreateTokenDialog({
  open,
  onOpenChange,
  form,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: ReturnType<typeof useForm<TokenFormValues>>;
  isPending: boolean;
  onSubmit: () => void;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create API key"
      description="Create an API key that authenticates as this service account."
      size="medium"
    >
      <DialogForm className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="service-account-token-name">Display name</Label>
            <FieldDescription>
              Name to easily identify the key.
            </FieldDescription>
            <Input
              id="service-account-token-name"
              placeholder="Deployment key"
              {...form.register("name", { required: true })}
            />
          </div>
          <ExpirationDateTimeField
            value={form.watch("expiresAt")}
            onChange={(value) => form.setValue("expiresAt", value)}
            noExpirationText="Key will never expire"
            formatExpiration={formatExpiration}
          />
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isPending || !form.watch("name").trim()}
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>Create</span>
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function CreatedTokenDialog({
  token,
  onClose,
}: {
  token: string | null;
  onClose: () => void;
}) {
  return (
    <FormDialog
      open={!!token}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="API key created"
      size="medium"
    >
      <DialogBody className="space-y-4">
        <div className="space-y-2">
          <Label>API key</Label>
          <FieldDescription>
            Copy this key now. It will not be shown again after you close this
            dialog.
          </FieldDescription>
          <CopyableCode
            value={token ?? ""}
            variant="primary"
            toastMessage="API key copied"
            className="break-all"
          />
        </div>
        {/* The key is already on screen, so putting it in a runnable command
            costs no extra exposure and answers the question that otherwise
            sends someone to the docs: how do I actually use this? */}
        <div className="space-y-2">
          <Label>Use it in a request</Label>
          <CopyableCode
            value={`curl -H "Authorization: ${token ?? ""}" ${apiBaseUrl()}/api/config`}
            toastMessage="Example request copied"
            className="break-all text-xs"
          />
        </div>
      </DialogBody>
      <DialogStickyFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

function formatExpiration(date: Date | string | null): string {
  return formatRelativeTime(date);
}
