"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowLeft,
  Copy,
  Loader2,
  Plus,
  Power,
  PowerOff,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { FormDialog } from "@/components/form-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { QueryLoadError } from "@/components/query-load-error";
import {
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { RoleSelect } from "@/components/ui/role-select";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { copyToClipboard } from "@/lib/clipboard";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import {
  type ServiceAccountToken,
  useCreateServiceAccountToken,
  useDeleteServiceAccountToken,
  useServiceAccount,
  useUpdateServiceAccount,
  useUpdateServiceAccountToken,
} from "@/lib/service-account.query";
import {
  formatRelativeTime,
  formatRelativeTimeFromNow,
} from "@/lib/utils/date-time";
import { useSetSettingsAction } from "../../layout";

type ServiceAccountFormValues = {
  name: string;
};

type TokenFormValues = {
  name: string;
  expiresAt: Date | null;
};

const DEFAULT_TOKEN_FORM_VALUES: TokenFormValues = {
  name: "",
  expiresAt: null,
};

export default function ServiceAccountDetailPage({
  serviceAccountId,
}: {
  serviceAccountId: string;
}) {
  const setActionButton = useSetSettingsAction();
  const { data: canReadServiceAccounts, isPending: isCheckingPermissions } =
    useHasPermissions({ serviceAccount: ["read"] });
  const { data: canUpdateServiceAccounts } = useHasPermissions({
    serviceAccount: ["update"],
  });
  const {
    data: serviceAccount,
    isPending,
    isLoadingError,
    refetch,
  } = useServiceAccount(serviceAccountId);
  const updateMutation = useUpdateServiceAccount();
  const createTokenMutation = useCreateServiceAccountToken();
  const updateTokenMutation = useUpdateServiceAccountToken();
  const deleteTokenMutation = useDeleteServiceAccountToken();

  const [selectedRole, setSelectedRole] = useState("member");
  const [isDisabled, setIsDisabled] = useState(false);
  const [isTokenDialogOpen, setIsTokenDialogOpen] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<ServiceAccountToken | null>(
    null,
  );

  const form = useForm<ServiceAccountFormValues>({
    defaultValues: { name: "" },
  });
  const apiDocsUrl = getFrontendDocsUrl("platform-api-reference");
  const tokenForm = useForm<TokenFormValues>({
    defaultValues: DEFAULT_TOKEN_FORM_VALUES,
  });

  const openTokenDialog = useCallback(() => {
    tokenForm.reset({
      name: serviceAccount ? `${serviceAccount.name} key` : "",
      expiresAt: null,
    });
    setIsTokenDialogOpen(true);
  }, [serviceAccount, tokenForm]);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ serviceAccount: ["update"] }}
        type="button"
        onClick={openTokenDialog}
      >
        <Plus className="h-4 w-4" />
        Create API Key
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [openTokenDialog, setActionButton]);

  useEffect(() => {
    if (!serviceAccount) return;

    form.reset({ name: serviceAccount.name });
    setSelectedRole(serviceAccount.role);
    setIsDisabled(serviceAccount.disabled);
  }, [form, serviceAccount]);

  const watchedName = form.watch("name");
  const hasChanges =
    !!serviceAccount &&
    (watchedName !== serviceAccount.name ||
      selectedRole !== serviceAccount.role ||
      isDisabled !== serviceAccount.disabled);

  const columns: ColumnDef<ServiceAccountToken>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="font-medium">{row.original.name}</div>
        ),
      },
      {
        accessorKey: "tokenStart",
        header: "Key",
        cell: ({ row }) => (
          <code className="text-xs">{row.original.tokenStart}...</code>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => formatRelativeTimeFromNow(row.original.createdAt),
      },
      {
        accessorKey: "lastUsedAt",
        header: "Last used",
        cell: ({ row }) => formatRelativeTimeFromNow(row.original.lastUsedAt),
      },
      {
        accessorKey: "expiresAt",
        header: "Expires",
        cell: ({ row }) => formatRelativeTime(row.original.expiresAt),
      },
      {
        accessorKey: "disabled",
        header: "Status",
        cell: ({ row }) =>
          row.original.disabled ? (
            <Badge variant="outline">Disabled</Badge>
          ) : (
            <Badge variant="secondary">Active</Badge>
          ),
      },
      ...(canUpdateServiceAccounts
        ? [
            {
              id: "actions",
              header: "Actions",
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
                      label: "Delete API key",
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

  const handleSave = async () => {
    if (!serviceAccount || !watchedName.trim()) return;

    await updateMutation.mutateAsync({
      id: serviceAccountId,
      body: {
        name: watchedName.trim(),
        role: selectedRole,
        disabled: isDisabled,
      },
    });
  };

  const handleCancel = () => {
    if (!serviceAccount) return;

    form.reset({ name: serviceAccount.name });
    setSelectedRole(serviceAccount.role);
    setIsDisabled(serviceAccount.disabled);
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
      body: {
        name: values.name.trim(),
        expiresIn,
      },
    });
    if (!token?.token) return;

    setIsTokenDialogOpen(false);
    setCreatedToken(token.token);
    tokenForm.reset(DEFAULT_TOKEN_FORM_VALUES);
  });

  const copyCreatedToken = async () => {
    if (!createdToken) return;

    await copyToClipboard(createdToken);
  };

  const closeCreatedTokenDialog = () => setCreatedToken(null);

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

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      {isLoadingError ? (
        <QueryLoadError
          title="Couldn't load this service account"
          onRetry={() => refetch()}
        />
      ) : !serviceAccount ? (
        <Alert variant="destructive">
          <AlertTitle>Service account not found</AlertTitle>
          <AlertDescription>
            This service account may have been deleted.
          </AlertDescription>
        </Alert>
      ) : (
        <SettingsSectionStack>
          <Button variant="ghost" size="sm" className="w-fit" asChild>
            <Link href="/settings/service-accounts">
              <ArrowLeft className="h-4 w-4" />
              Back to Service Accounts
            </Link>
          </Button>

          <div className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
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
            <div className="mt-5 flex items-center justify-between rounded-md border p-4">
              <div className="space-y-1">
                <Label htmlFor="service-account-disabled">
                  Disable service account
                </Label>
                <p className="text-sm text-muted-foreground">
                  Disabled service accounts cannot authenticate with any of
                  their API keys.
                </p>
              </div>
              <Switch
                id="service-account-disabled"
                checked={isDisabled}
                onCheckedChange={setIsDisabled}
                disabled={!canUpdateServiceAccounts}
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold">API Keys</h3>
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
                  "platform API"
                )}{" "}
                as this service account.
              </p>
            </div>
            <DataTable
              columns={columns}
              data={serviceAccount.tokens}
              emptyMessage="No API keys yet"
            />
          </div>

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
            onCopy={copyCreatedToken}
            onClose={closeCreatedTokenDialog}
          />
          <DeleteConfirmDialog
            open={!!keyToDelete}
            onOpenChange={(open) => !open && setKeyToDelete(null)}
            title="Delete API Key"
            description="This will immediately revoke access for anything using this key."
            isPending={deleteTokenMutation.isPending}
            onConfirm={handleDeleteKey}
            confirmLabel="Delete"
            pendingLabel="Deleting..."
          />
        </SettingsSectionStack>
      )}
    </LoadingWrapper>
  );
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
            Create
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function CreatedTokenDialog({
  token,
  onCopy,
  onClose,
}: {
  token: string | null;
  onCopy: () => Promise<void>;
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
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              readOnly
              aria-label="Service account API key"
              value={token ?? ""}
              className="font-mono text-xs"
            />
            <Button type="button" onClick={onCopy}>
              <Copy className="h-4 w-4" />
              Copy to clipboard
            </Button>
          </div>
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
