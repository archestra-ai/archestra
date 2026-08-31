"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Plus,
  Power,
  PowerOff,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { CopyableCode } from "@/components/copyable-code";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { FormDialog } from "@/components/form-dialog";
import { LoadingState, LoadingWrapper } from "@/components/loading";
import { OverviewSummary } from "@/components/overview-summary";
import { PageBackLink } from "@/components/page-back-link";
import { QueryLoadError } from "@/components/query-load-error";
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
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { RoleSelect } from "@/components/ui/role-select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
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
 * Placeholder standing in for a real key in the example request. Deliberately
 * not a plausible key, so a pasted command fails loudly rather than looking
 * like it carries a working credential.
 */
const EXAMPLE_KEY = "arch_YOUR_KEY";

export default function ServiceAccountDetailPage({
  serviceAccountId,
}: {
  serviceAccountId: string;
}) {
  const setActionButton = useSetSettingsAction();
  const setPageHeader = useSetSettingsPageHeader();
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
      backLink: (
        <PageBackLink href="/settings/service-accounts">
          Back to service accounts
        </PageBackLink>
      ),
    });

    return () => setPageHeader(null);
  }, [health, serviceAccount, setPageHeader]);

  useEffect(() => {
    if (!serviceAccount) return;

    form.reset({ name: serviceAccount.name });
    setSelectedRole(serviceAccount.role);
  }, [form, serviceAccount]);

  const watchedName = form.watch("name");
  const hasChanges =
    !!serviceAccount &&
    (watchedName !== serviceAccount.name ||
      selectedRole !== serviceAccount.role);

  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected: selectedTokens,
  } = useBulkSelection({
    rows: tokens,
    getId: (token) => token.id,
    filterSignature: serviceAccountId,
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
          <CopyableCode
            value={row.original.tokenStart}
            toastMessage="Key prefix copied"
            className="w-fit gap-1 px-2 py-1 text-xs"
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
        size: 150,
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <KeyStatusBadge status={getKeyStatus(row.original)} />
            <ExpiryNote token={row.original} />
          </div>
        ),
      },
      {
        accessorKey: "lastUsedAt",
        header: "Last used",
        size: 100,
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
              size: 96,
              cell: ({ row }) => (
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

    await updateMutation.mutateAsync({
      id: serviceAccountId,
      body: { name: watchedName.trim(), role: selectedRole },
    });
  };

  const handleCancel = () => {
    if (!serviceAccount) return;

    form.reset({ name: serviceAccount.name });
    setSelectedRole(serviceAccount.role);
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
      loadingFallback={<LoadingState variant="page" />}
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
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>This service account cannot authenticate</AlertTitle>
              <AlertDescription>{healthExplanation}</AlertDescription>
            </Alert>
          )}

          <OverviewSummary
            headingId="service-account-overview"
            facts={[
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
            ]}
          />

          <section aria-labelledby="service-account-keys" className="space-y-3">
            <div className="space-y-1">
              <h2
                id="service-account-keys"
                className="text-base font-semibold tracking-tight text-foreground"
              >
                API keys
              </h2>
              <p className="text-sm text-muted-foreground">
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
            </div>

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
              data={tokens}
              getRowId={(row) => row.id}
              rowSelection={rowSelection}
              onRowSelectionChange={setRowSelection}
              onPageRowIdsChange={onPageRowIdsChange}
              hideSelectedCount
              emptyIcon={KeyRound}
              emptyMessage="No API keys yet"
              emptyDescription="Without a key this service account cannot authenticate. Create one to start using it."
              hidePaginationWhenSinglePage
              // These sizes sum to 690 with the 56px select column, so the
              // table fits the settings shell instead of hiding Actions behind
              // a horizontal scroll.
              fixedWidthColumnIds={[
                "tokenStart",
                "disabled",
                "lastUsedAt",
                "actions",
              ]}
              flexibleColumnIds={["name"]}
            />

            {canAuthenticate(health) && (
              <div className="space-y-2">
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
          </section>

          <SettingsBlock
            title="Account settings"
            description="The display name shown across the platform, and the role every request made with this account's keys is authorized against."
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
                <Label htmlFor="service-account-role">Role</Label>
                <RoleSelect
                  key={selectedRole}
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

          <SettingsSaveBar
            hasChanges={hasChanges}
            isSaving={updateMutation.isPending}
            permissions={{ serviceAccount: ["update"] }}
            onSave={handleSave}
            onCancel={handleCancel}
            disabledSave={!watchedName.trim()}
          />

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
 * The reason under a key's status badge: when it lapses, or when it did. Says
 * nothing at all for an open-ended key, because "Never expires" on every row
 * is noise that makes the rows that do expire harder to spot.
 */
function ExpiryNote({ token }: { token: ServiceAccountToken }) {
  if (!token.expiresAt) return null;

  const status = getKeyStatus(token);
  if (status === "expired") {
    return (
      <p className="text-xs text-muted-foreground">
        Expired {formatRelativeTimeFromNow(token.expiresAt)}
      </p>
    );
  }

  const days = daysUntil(token.expiresAt);
  return (
    <p
      className={
        status === "expiring"
          ? "text-xs text-amber-700 dark:text-amber-400"
          : "text-xs text-muted-foreground"
      }
    >
      Expires in {days} {days === 1 ? "day" : "days"}
    </p>
  );
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
            <Input
              id="service-account-token-name"
              placeholder="Deployment key"
              {...form.register("name", { required: true })}
            />
            <p className="text-xs text-muted-foreground">
              Name to easily identify the key.
            </p>
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
          <p className="text-sm text-muted-foreground">
            Copy this key now. It will not be shown again after you close this
            dialog.
          </p>
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
