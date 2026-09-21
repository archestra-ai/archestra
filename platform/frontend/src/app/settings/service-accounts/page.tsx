"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Bot, ListFilter, Plus, Power, PowerOff, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EntityLabelFilter } from "@/components/entity-label-filter";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { FormDialog } from "@/components/form-dialog";
import { LabelTags } from "@/components/label-tags";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { AccountHealthBadge } from "@/components/service-account-status-badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { RoleSelect } from "@/components/ui/role-select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import {
  useServiceAccountLabelKeys,
  useServiceAccountLabelValues,
} from "@/lib/entity-labels.query";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  type ServiceAccount,
  useBulkDeleteServiceAccounts,
  useBulkSetServiceAccountsDisabled,
  useCreateServiceAccount,
  useDeleteServiceAccount,
  useServiceAccounts,
} from "@/lib/service-account.query";
import {
  ACCOUNT_HEALTH_LABELS,
  type AccountHealth,
  getAccountHealth,
} from "@/lib/service-account-status";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { formatRoleName } from "@/lib/utils/role";
import { useSetSettingsAction } from "../layout";

type ServiceAccountFormValues = {
  name: string;
  role: string;
};

const DEFAULT_FORM_VALUES: ServiceAccountFormValues = {
  name: "",
  role: "member",
};

const ALL = "all";

/**
 * Statuses worth filtering to, most actionable first. "No usable key" is the
 * reason this filter exists: those accounts look healthy in every other column
 * and are exactly the ones an operator needs to find.
 */
const STATUS_FILTERS: AccountHealth[] = [
  "no-usable-keys",
  "expiring",
  "no-keys",
  "active",
  "disabled",
];

export default function ServiceAccountsSettingsPage() {
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const router = useRouter();
  const setActionButton = useSetSettingsAction();
  const { data: canReadServiceAccounts, isPending: isCheckingPermissions } =
    useHasPermissions({ serviceAccount: ["read"] });
  const { data: canUpdateServiceAccounts } = useHasPermissions({
    serviceAccount: ["update"],
  });
  const { data: canDeleteServiceAccounts } = useHasPermissions({
    serviceAccount: ["delete"],
  });
  // Label filtering is server-side, so the value rides the query rather than
  // narrowing the already-fetched list in the browser.
  const labelsFilter = searchParams.get("labels") || undefined;
  const {
    data: serviceAccounts = [],
    isPending,
    isFetching,
    isLoadingError: isServiceAccountsLoadError,
    refetch: refetchServiceAccounts,
  } = useServiceAccounts({ labels: labelsFilter });
  const createMutation = useCreateServiceAccount();
  const deleteMutation = useDeleteServiceAccount();
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const bulkDelete = useBulkDeleteServiceAccounts();
  const bulkSetDisabled = useBulkSetServiceAccountsDisabled();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [newLabels, setNewLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const [accountToDelete, setAccountToDelete] = useState<ServiceAccount | null>(
    null,
  );
  const search = searchParams.get("search") || "";
  const roleFilter = searchParams.get("role") || ALL;
  const statusFilter = searchParams.get("status") || ALL;
  const hasActiveFilters =
    search.trim().length > 0 ||
    roleFilter !== ALL ||
    statusFilter !== ALL ||
    Boolean(labelsFilter);

  const form = useForm<ServiceAccountFormValues>({
    defaultValues: DEFAULT_FORM_VALUES,
  });

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ serviceAccount: ["create"] }}
        onClick={() => {
          form.reset(DEFAULT_FORM_VALUES);
          setIsCreateDialogOpen(true);
        }}
      >
        <Plus className="h-4 w-4" />
        Create service account
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [form, setActionButton]);

  const clearFilters = useCallback(
    () =>
      updateQueryParams({
        search: null,
        role: null,
        status: null,
        labels: null,
        page: "1",
      }),
    [updateQueryParams],
  );

  const filteredServiceAccounts = useMemo(() => {
    const query = search.trim().toLowerCase();
    const now = new Date();

    return serviceAccounts.filter((account) => {
      if (query && !account.name.toLowerCase().includes(query)) return false;
      if (roleFilter !== ALL && !account.role.split(",").includes(roleFilter))
        return false;
      if (
        statusFilter !== ALL &&
        getAccountHealth(account, now) !== statusFilter
      ) {
        return false;
      }
      return true;
    });
  }, [serviceAccounts, search, roleFilter, statusFilter]);

  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected: selectedAccounts,
    selectAllMatching,
  } = useBulkSelection({
    rows: filteredServiceAccounts,
    getId: (account) => account.id,
    filterSignature: `${search}|${roleFilter}|${statusFilter}|${labelsFilter ?? ""}`,
    matchDescription: hasActiveFilters ? "match these filters" : "exist",
  });

  const setDisabled = bulkSetDisabled.mutate;
  const renderRowActions = useCallback(
    (account: ServiceAccount) => (
      <TableRowActions
        itemName={account.name}
        actions={[
          ...(canUpdateServiceAccounts
            ? [
                {
                  icon: account.disabled ? (
                    <Power className="h-4 w-4" />
                  ) : (
                    <PowerOff className="h-4 w-4" />
                  ),
                  label: account.disabled
                    ? "Enable service account"
                    : "Disable service account",
                  onClick: () =>
                    setDisabled({
                      accounts: [account],
                      disabled: !account.disabled,
                    }),
                },
              ]
            : []),
          ...(canDeleteServiceAccounts
            ? [
                {
                  icon: <Trash2 className="h-4 w-4" />,
                  label: "Delete service account",
                  onClick: () => setAccountToDelete(account),
                  variant: "destructive" as const,
                },
              ]
            : []),
        ]}
      />
    ),
    [canDeleteServiceAccounts, canUpdateServiceAccounts, setDisabled],
  );

  // `DataTable` sets the table's `minWidth` to the sum of these sizes, so the
  // sum has to fit the settings shell's content column (~718px at 1200px wide)
  // or trailing columns disappear behind a horizontal scroll. These add up to
  // 710 including the 56px select column, and each is wide enough for its own
  // header to sit on one line.
  const columns: ColumnDef<ServiceAccount>[] = useMemo(() => {
    const baseColumns: ColumnDef<ServiceAccount>[] = [
      createSelectColumn<ServiceAccount>({
        rowLabel: (account) => `Select ${account.name}`,
        allLabel: "Select all service accounts on this page",
      }),
      {
        accessorKey: "name",
        header: "Account",
        size: 160,
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-1.5">
            <Link
              className="truncate font-medium hover:underline"
              href={`/settings/service-accounts/${row.original.id}`}
              title={row.original.name}
            >
              {row.original.name}
            </Link>
            <LabelTags labels={row.original.labels} />
          </div>
        ),
      },
      {
        accessorKey: "role",
        header: "Role",
        size: 88,
        cell: ({ row }) => (
          <Badge variant="secondary">{formatRoleName(row.original.role)}</Badge>
        ),
      },
      {
        accessorKey: "disabled",
        header: "Status",
        size: 112,
        cell: ({ row }) => (
          <AccountHealthBadge health={getAccountHealth(row.original)} />
        ),
      },
      {
        accessorKey: "tokenCount",
        header: "API keys",
        size: 90,
        cell: ({ row }) => <KeyCount account={row.original} />,
      },
      {
        accessorKey: "lastUsedAt",
        header: "Last used",
        size: 108,
        cell: ({ row }) => <LastUsed account={row.original} />,
      },
      // "Created" is deliberately absent. The settings shell gives this table a
      // narrower column than a top-level page, and an eighth column pushed
      // Actions off-screen. For a machine identity "last used" is the
      // operational question; the creation date is archival and still shown on
      // the account's own page.
    ];

    if (!canUpdateServiceAccounts && !canDeleteServiceAccounts) {
      return baseColumns;
    }

    return [
      ...baseColumns,
      {
        id: "actions",
        header: "Actions",
        // Two icon-sm buttons with the table's px-4 inset on both sides, so
        // the last icon sits 16px from the frame like every other cell edge.
        size: 96,
        cell: ({ row }) => renderRowActions(row.original),
      },
    ];
  }, [canDeleteServiceAccounts, canUpdateServiceAccounts, renderRowActions]);

  const closeDialog = () => {
    setIsCreateDialogOpen(false);
    form.reset(DEFAULT_FORM_VALUES);
    setNewLabels([]);
  };

  const handleSubmit = form.handleSubmit(async (values) => {
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? newLabels;
    const account = await createMutation.mutateAsync({
      name: values.name.trim(),
      role: values.role,
      labels: finalLabels,
    });
    if (!account) return;

    closeDialog();
    router.push(`/settings/service-accounts/${account.id}`);
  });

  const handleDelete = async () => {
    if (!accountToDelete) return;
    await deleteMutation.mutateAsync(accountToDelete.id);
    setAccountToDelete(null);
  };

  const applyBulkDisabled = (disabled: boolean) =>
    bulkSetDisabled.mutate(
      { accounts: selectedAccounts, disabled },
      {
        onSuccess: (outcome) => {
          reportBulkOutcome({
            outcome,
            verb: disabled ? "Disabled" : "Enabled",
            failureVerb: disabled ? "disable" : "enable",
            noun: "service account",
          });
          if (outcome.failed.length === 0) clearSelection();
        },
      },
    );

  return (
    <div className="space-y-6">
      {!isCheckingPermissions && !canReadServiceAccounts ? (
        <Alert variant="destructive">
          <AlertTitle>Access denied</AlertTitle>
          <AlertDescription>
            You do not have permission to view service accounts.
          </AlertDescription>
        </Alert>
      ) : (
        /* The filters and the table report their own first load rather than
           being replaced by a centred loader. Swapping a full-height indicator
           out for the whole view meant the toolbar and headers arrived a beat
           after the wait had visibly ended, so one navigation read as loader,
           then components, then content. */
        <BulkActionsScope>
          <div>
            <CollectionFilters>
              <FilterBar
                onClearFilters={hasActiveFilters ? clearFilters : undefined}
                search={
                  <SearchInput
                    objectNamePlural="service accounts"
                    searchFields={["name"]}
                    className={filterSearchClass}
                  />
                }
              >
                <RoleSelect
                  mode="filter"
                  value={roleFilter}
                  onValueChange={(value) =>
                    updateQueryParams({
                      role: value === ALL ? null : value,
                      page: "1",
                    })
                  }
                  allOptionValue={ALL}
                />
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
                  // filter and the Status column teach one vocabulary rather
                  // than two. `label` stays the bare word, which is what the
                  // list is searched and announced by.
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
                    ...STATUS_FILTERS.map((health) => ({
                      value: health,
                      label: ACCOUNT_HEALTH_LABELS[health],
                      content: <AccountHealthBadge health={health} />,
                    })),
                  ]}
                />
                <EntityLabelFilter
                  useLabelKeys={useServiceAccountLabelKeys}
                  useLabelValues={useServiceAccountLabelValues}
                  className={filterControlClass({
                    active: Boolean(labelsFilter),
                  })}
                />
              </FilterBar>
            </CollectionFilters>
            {isServiceAccountsLoadError ? (
              <QueryLoadError
                title="Couldn't load your service accounts"
                onRetry={() => refetchServiceAccounts()}
              />
            ) : (
              <>
                <BulkActions
                  count={selectedAccounts.length}
                  noun="service account"
                  onClear={clearSelection}
                  busy={bulkDelete.isPending || bulkSetDisabled.isPending}
                  selectAllMatching={selectAllMatching}
                >
                  <PermissionButton
                    permissions={{ serviceAccount: ["update"] }}
                    variant="outline"
                    size="sm"
                    onClick={() => applyBulkDisabled(false)}
                  >
                    <Power className="h-4 w-4" />
                    <span>Enable</span>
                  </PermissionButton>
                  <PermissionButton
                    permissions={{ serviceAccount: ["update"] }}
                    variant="outline"
                    size="sm"
                    onClick={() => applyBulkDisabled(true)}
                  >
                    <PowerOff className="h-4 w-4" />
                    <span>Disable</span>
                  </PermissionButton>
                  <PermissionButton
                    permissions={{ serviceAccount: ["delete"] }}
                    variant="destructive"
                    size="sm"
                    onClick={() => setBulkDeleteOpen(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                    <span>Delete</span>
                  </PermissionButton>
                </BulkActions>
                <DataTable
                  columns={columns}
                  data={filteredServiceAccounts}
                  isLoading={
                    (isPending || isFetching) && serviceAccounts.length === 0
                  }
                  getRowId={(row) => row.id}
                  rowSelection={rowSelection}
                  onRowSelectionChange={setRowSelection}
                  onPageRowIdsChange={onPageRowIdsChange}
                  hideSelectedCount
                  onRowClick={(account, event) => {
                    const target = event.target as HTMLElement;
                    if (target.closest("a,button")) return;
                    router.push(`/settings/service-accounts/${account.id}`);
                  }}
                  emptyIcon={Bot}
                  emptyMessage="No service accounts yet"
                  emptyDescription="Service accounts are organization-owned identities that let scripts and integrations call the platform API."
                  hasActiveFilters={hasActiveFilters}
                  filteredEmptyMessage="No service accounts match your filters"
                  onClearFilters={clearFilters}
                  hidePaginationWhenSinglePage
                  fixedWidthColumnIds={[
                    "role",
                    "disabled",
                    "tokenCount",
                    "lastUsedAt",
                    "actions",
                  ]}
                  flexibleColumnIds={["name"]}
                />
              </>
            )}
          </div>
        </BulkActionsScope>
      )}

      {bulkDeleteOpen && (
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="Delete service accounts"
          description={`Delete ${selectedAccounts.length} ${
            selectedAccounts.length === 1
              ? "service account"
              : "service accounts"
          }? Their keys stop working immediately. To stop them reversibly, disable them instead.`}
          isPending={bulkDelete.isPending}
          onConfirm={() => {
            bulkDelete.mutate(selectedAccounts, {
              onSuccess: (outcome) => {
                reportBulkOutcome({
                  outcome,
                  verb: "Deleted",
                  failureVerb: "delete",
                  noun: "service account",
                });
                setBulkDeleteOpen(false);
                if (outcome.failed.length === 0) clearSelection();
              },
            });
          }}
          confirmLabel="Delete service accounts"
          pendingLabel="Deleting..."
        />
      )}

      <FormDialog
        open={isCreateDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title="Create service account"
        size="medium"
      >
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={handleSubmit}
        >
          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="service-account-name">Display name</Label>
              <FieldDescription>
                The display name for this service account.
              </FieldDescription>
              <Input
                id="service-account-name"
                {...form.register("name", { required: true })}
                placeholder="Automation service account"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="service-account-role">Roles</Label>
              <RoleSelect
                multiple
                id="service-account-role"
                value={form.watch("role")}
                onValueChange={(role) => form.setValue("role", role)}
                placeholder="Select a role"
                className="w-full"
              />
              <FieldDescription>
                Roles set allowed actions for API requests. Resource permissions
                determine which objects this account can reach.
              </FieldDescription>
            </div>
            <AdvancedLabelsSection
              ref={labelsRef}
              labels={newLabels}
              onLabelsChange={setNewLabels}
            />
          </DialogBody>
          <DialogStickyFooter>
            <Button type="button" variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              Create
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      <DeleteConfirmDialog
        open={!!accountToDelete}
        onOpenChange={(open) => {
          if (!open) setAccountToDelete(null);
        }}
        title="Delete service account"
        description="Deleting a service account immediately invalidates all of its API keys. To stop it reversibly, disable it instead."
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}

// === Internal helpers

/**
 * Keys as "usable of total", collapsing to one number when they agree. `2` and
 * `0 of 2` are very different situations that a bare count renders identically.
 */
function KeyCount({ account }: { account: ServiceAccount }) {
  if (account.tokenCount === 0) return <span>None</span>;
  if (account.activeTokenCount === account.tokenCount) {
    return <span>{account.tokenCount}</span>;
  }
  return (
    <span
      title={`${account.activeTokenCount} of ${account.tokenCount} keys usable`}
    >
      {account.activeTokenCount} / {account.tokenCount}
    </span>
  );
}

function LastUsed({ account }: { account: ServiceAccount }) {
  if (!account.lastUsedAt) {
    return <span className="text-muted-foreground">Never used</span>;
  }
  return <span>{formatRelativeTimeFromNow(account.lastUsedAt)}</span>;
}
