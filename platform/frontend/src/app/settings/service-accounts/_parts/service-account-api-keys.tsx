"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  Copy,
  KeyRound,
  ListFilter,
  Loader2,
  Power,
  PowerOff,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { CopyableCode } from "@/components/copyable-code";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { FormDialog } from "@/components/form-dialog";
import { SearchInput } from "@/components/search-input";
import { KeyStatusBadge } from "@/components/service-account-status-badge";
import { TableRowActions } from "@/components/table-row-actions";
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
import { reportBulkOutcome } from "@/lib/bulk-action";
import { copyToClipboard } from "@/lib/clipboard";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import {
  type ServiceAccountDetail,
  type ServiceAccountToken,
  useBulkServiceAccountTokenAction,
  useCreateServiceAccountToken,
  useDeleteServiceAccountToken,
  useUpdateServiceAccountToken,
} from "@/lib/service-account.query";
import {
  getKeyStatus,
  KEY_STATUS_LABELS,
  type KeyStatus,
} from "@/lib/service-account-status";
import {
  formatRelativeTime,
  formatRelativeTimeFromNow,
} from "@/lib/utils/date-time";

/**
 * The API keys of one service account: list, filter, create, deactivate and
 * revoke them, with the request that shows how a key is used. It has its own
 * tab on the account's page.
 */
export function ServiceAccountApiKeys({
  serviceAccount,
  canUpdate,
  createOpen,
  onCreateOpenChange,
}: {
  serviceAccount: ServiceAccountDetail;
  canUpdate: boolean;
  /** The create dialog, opened from the page header's Create key button. */
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const serviceAccountId = serviceAccount.id;
  const createTokenMutation = useCreateServiceAccountToken();
  const updateTokenMutation = useUpdateServiceAccountToken();
  const deleteTokenMutation = useDeleteServiceAccountToken();
  const bulkTokenAction = useBulkServiceAccountTokenAction();

  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<ServiceAccountToken | null>(
    null,
  );
  const [bulkRevokeOpen, setBulkRevokeOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(ALL);
  const tokenForm = useForm<TokenFormValues>({
    defaultValues: DEFAULT_TOKEN_FORM_VALUES,
  });

  const tokens = serviceAccount.tokens;
  const hasActiveFilters = search.trim().length > 0 || statusFilter !== ALL;

  const clearFilters = useCallback(() => {
    setSearch("");
    setStatusFilter(ALL);
  }, []);

  const filteredTokens = useMemo(() => {
    const query = search.trim().toLowerCase();
    const now = new Date();

    return tokens.filter((token) => {
      if (
        query &&
        !token.name.toLowerCase().includes(query) &&
        !token.tokenStart.toLowerCase().includes(query)
      ) {
        return false;
      }
      if (statusFilter !== ALL && getKeyStatus(token, now) !== statusFilter) {
        return false;
      }
      return true;
    });
  }, [tokens, search, statusFilter]);

  // Each time the header opens the dialog, it starts from a fresh name.
  const accountName = serviceAccount.name;
  useEffect(() => {
    if (createOpen) {
      tokenForm.reset({ name: `${accountName} key`, expiresAt: null });
    }
  }, [createOpen, accountName, tokenForm]);

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
      ...(canUpdate
        ? [
            createSelectColumn<ServiceAccountToken>({
              rowLabel: (token) => `Select ${token.name}`,
              allLabel: "Select all API keys on this page",
            }),
          ]
        : []),
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        size: 260,
        cell: ({ row }) => (
          // The prefix sits under the name, as on the virtual keys page: it is
          // how a key here is matched against one in a CI secret store, and it
          // does not need a column of its own to do that.
          <div className="min-w-0">
            <div className="truncate font-medium" title={row.original.name}>
              {row.original.name}
            </div>
            <KeyPrefix tokenStart={row.original.tokenStart} />
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        size: 120,
        cell: ({ row }) => (
          <KeyStatusBadge status={getKeyStatus(row.original)} />
        ),
      },
      {
        // Last use and expiry read as one column, as on the virtual keys page:
        // when a key was last needed and when it stops working.
        id: "activity",
        header: "Activity",
        size: 170,
        cell: ({ row }) => (
          <div className="space-y-0.5 text-xs">
            <div>
              <span className="text-muted-foreground">Used </span>
              {row.original.lastUsedAt
                ? formatRelativeTimeFromNow(row.original.lastUsedAt, {
                    strict: true,
                  })
                : "never"}
            </div>
            <div>
              <ExpiryReading expiresAt={row.original.expiresAt} />
            </div>
          </div>
        ),
      },
      ...(canUpdate
        ? [
            {
              id: "actions",
              header: "Actions",
              // Two icon buttons plus the cell's padding; any narrower and
              // they press against the table's right edge.
              size: 100,
              cell: ({ row }) => (
                // Inline icon buttons, as in the service account list and the
                // federated credentials table.
                <TableRowActions
                  itemName={row.original.name}
                  actions={[
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
    [canUpdate, serviceAccountId, updateTokenMutation],
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

    onCreateOpenChange(false);
    setCreatedToken(token.token);
    tokenForm.reset(DEFAULT_TOKEN_FORM_VALUES);
  });

  return (
    <BulkActionsScope>
      <section className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Long-lived keys for scripts and tools that can&apos;t use a federated
          credential.
        </p>
        {/* Search and status filter earn their row only once there is
            something to filter. */}
        {tokens.length > 0 && (
          <CollectionFilters>
            <FilterBar
              onClearFilters={hasActiveFilters ? clearFilters : undefined}
              search={
                <SearchInput
                  objectNamePlural="API keys"
                  searchFields={["name", "key"]}
                  className={filterSearchClass}
                  syncQueryParams={false}
                  value={search}
                  onSearchChange={setSearch}
                />
              }
            >
              <FilterSelect
                value={statusFilter}
                onValueChange={setStatusFilter}
                placeholder="Filter by status"
                // Each option renders as the reading it selects, so the filter
                // teaches the same vocabulary the Status column uses. `label`
                // stays the bare word, which is what the option list is
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
        )}

        {canUpdate && (
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
          emptyDescription="Create one for a script or tool that can't use a federated credential."
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage="No API keys match your filters"
          onClearFilters={clearFilters}
          hidePaginationWhenSinglePage
          fixedWidthColumnIds={["status", "activity", "actions"]}
          flexibleColumnIds={["name"]}
        />
        <CreateTokenDialog
          open={createOpen}
          onOpenChange={onCreateOpenChange}
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
      </section>
    </BulkActionsScope>
  );
}

// === Internal helpers

type TokenFormValues = {
  name: string;
  expiresAt: Date | null;
};

const DEFAULT_TOKEN_FORM_VALUES: TokenFormValues = {
  name: "",
  expiresAt: null,
};

/** Sentinel for "no filter", matching the service accounts list. */
const ALL = "all";

/** Offered in severity order, the order the statuses are derived in. */
const KEY_STATUS_FILTERS: KeyStatus[] = [
  "expired",
  "expiring",
  "active",
  "disabled",
];

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
            formatExpiration={formatRelativeTime}
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

/**
 * A stored key as the virtual keys page shows one: its prefix in muted mono,
 * with a copy button. The prefix is all that is ever shown again of a key.
 */
function KeyPrefix({ tokenStart }: { tokenStart: string }) {
  return (
    // min-w-0 + overflow-hidden: the table's fixed layout does not clip cell
    // content, so an unconstrained row would paint over the next column.
    <div className="flex h-5 min-w-0 items-center gap-0.5 overflow-hidden font-mono text-xs text-muted-foreground">
      <code className="min-w-0 truncate">{`${tokenStart}…`}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-5 shrink-0"
        aria-label="Copy key prefix"
        onClick={async () => {
          await copyToClipboard(tokenStart);
          toast.success("Key prefix copied");
        }}
      >
        <Copy className="size-3" />
      </Button>
    </div>
  );
}

/** "Expires in 4 months", "Expired 9 days ago" or "Expires never". */
function ExpiryReading({ expiresAt }: { expiresAt: string | null }) {
  if (expiresAt && new Date(expiresAt) <= new Date()) {
    return (
      <>
        <span className="text-muted-foreground">Expired </span>
        {formatRelativeTimeFromNow(expiresAt, { strict: true })}
      </>
    );
  }
  return (
    <>
      <span className="text-muted-foreground">Expires </span>
      {formatRelativeTime(expiresAt, { neverLabel: "never" })}
    </>
  );
}
