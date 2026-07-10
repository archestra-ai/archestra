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
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
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

  const form = useForm<ServiceAccountFormValues>({
    defaultValues: { name: "" },
  });
  const tokenForm = useForm<TokenFormValues>({
    defaultValues: DEFAULT_TOKEN_FORM_VALUES,
  });

  const openTokenDialog = useCallback(() => {
    tokenForm.reset({
      name: serviceAccount ? `${serviceAccount.name} token` : "",
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
        Add token
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
        header: "Token prefix",
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
                  actions={[
                    {
                      icon: row.original.disabled ? (
                        <Power className="h-4 w-4" />
                      ) : (
                        <PowerOff className="h-4 w-4" />
                      ),
                      label: row.original.disabled
                        ? "Activate token"
                        : "Deactivate token",
                      onClick: () =>
                        updateTokenMutation.mutate({
                          id: serviceAccountId,
                          tokenId: row.original.id,
                          body: { disabled: !row.original.disabled },
                        }),
                    },
                    {
                      icon: <Trash2 className="h-4 w-4" />,
                      label: "Delete token",
                      onClick: () =>
                        deleteTokenMutation.mutate({
                          id: serviceAccountId,
                          tokenId: row.original.id,
                        }),
                      variant: "destructive" as const,
                    },
                  ]}
                />
              ),
            } satisfies ColumnDef<ServiceAccountToken>,
          ]
        : []),
    ],
    [
      canUpdateServiceAccounts,
      deleteTokenMutation,
      serviceAccountId,
      updateTokenMutation,
    ],
  );

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

    await navigator.clipboard.writeText(createdToken);
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
                  Disabled service accounts cannot authenticate with any token.
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
            <h3 className="text-lg font-semibold">Tokens</h3>
            <DataTable
              columns={columns}
              data={serviceAccount.tokens}
              emptyMessage="No tokens yet"
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
      title="Add service account token"
      size="medium"
    >
      <DialogForm className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="service-account-token-name">Display name</Label>
            <Input
              id="service-account-token-name"
              placeholder="Deployment token"
              {...form.register("name", { required: true })}
            />
            <p className="text-xs text-muted-foreground">
              Name to easily identify the token.
            </p>
          </div>
          <ExpirationDateTimeField
            value={form.watch("expiresAt")}
            onChange={(value) => form.setValue("expiresAt", value)}
            noExpirationText="Token will never expire"
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
            Generate token
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
      title="Service account token created"
      size="medium"
    >
      <DialogBody className="space-y-4">
        <div className="space-y-2">
          <Label>Token</Label>
          <p className="text-sm text-muted-foreground">
            Copy the token now as you will not be able to see it again. Losing a
            token requires creating a new one.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              readOnly
              aria-label="Service account token"
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
