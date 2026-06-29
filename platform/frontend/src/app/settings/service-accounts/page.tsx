"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { QueryLoadError } from "@/components/query-load-error";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { RoleSelect } from "@/components/ui/role-select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  type ServiceAccount,
  useCreateServiceAccount,
  useDeleteServiceAccount,
  useServiceAccounts,
} from "@/lib/service-account.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { useSetSettingsAction } from "../layout";

type ServiceAccountFormValues = {
  name: string;
  role: string;
};

const DEFAULT_FORM_VALUES: ServiceAccountFormValues = {
  name: "",
  role: "member",
};

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
  const {
    data: serviceAccounts = [],
    isPending,
    isLoadingError: isServiceAccountsLoadError,
    refetch: refetchServiceAccounts,
  } = useServiceAccounts();
  const createMutation = useCreateServiceAccount();
  const deleteMutation = useDeleteServiceAccount();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [accountToDelete, setAccountToDelete] = useState<ServiceAccount | null>(
    null,
  );
  const search = searchParams.get("search") || "";

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

  const filteredServiceAccounts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return serviceAccounts;

    return serviceAccounts.filter((account) =>
      account.name.toLowerCase().includes(query),
    );
  }, [serviceAccounts, search]);

  const columns: ColumnDef<ServiceAccount>[] = useMemo(() => {
    const baseColumns: ColumnDef<ServiceAccount>[] = [
      {
        accessorKey: "name",
        header: "Account",
        cell: ({ row }) => (
          <Link
            className="font-medium hover:underline"
            href={`/settings/service-accounts/${row.original.id}`}
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        accessorKey: "role",
        header: "Role",
        cell: ({ row }) => (
          <Badge variant="secondary">{formatRoleName(row.original.role)}</Badge>
        ),
      },
      {
        accessorKey: "tokenCount",
        header: "Tokens",
        cell: ({ row }) => row.original.tokenCount,
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
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => formatRelativeTimeFromNow(row.original.createdAt),
      },
    ];

    if (!canUpdateServiceAccounts && !canDeleteServiceAccounts) {
      return baseColumns;
    }

    return [
      ...baseColumns,
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <TableRowActions
            actions={[
              ...(canUpdateServiceAccounts
                ? [
                    {
                      icon: <Pencil className="h-4 w-4" />,
                      label: "Edit service account",
                      onClick: () =>
                        router.push(
                          `/settings/service-accounts/${row.original.id}`,
                        ),
                    },
                  ]
                : []),
              ...(canDeleteServiceAccounts
                ? [
                    {
                      icon: <Trash2 className="h-4 w-4" />,
                      label: "Delete service account",
                      onClick: () => setAccountToDelete(row.original),
                      variant: "destructive" as const,
                    },
                  ]
                : []),
            ]}
          />
        ),
      },
    ];
  }, [canDeleteServiceAccounts, canUpdateServiceAccounts, router]);

  const closeDialog = () => {
    setIsCreateDialogOpen(false);
    form.reset(DEFAULT_FORM_VALUES);
  };

  const handleSubmit = form.handleSubmit(async (values) => {
    const account = await createMutation.mutateAsync({
      name: values.name.trim(),
      role: values.role,
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
        <LoadingWrapper
          isPending={isPending}
          loadingFallback={<LoadingSpinner />}
        >
          <div className="space-y-4">
            <SearchInput
              objectNamePlural="service accounts"
              searchFields={["name"]}
            />
            {isServiceAccountsLoadError ? (
              <QueryLoadError
                title="Couldn't load your service accounts"
                onRetry={() => refetchServiceAccounts()}
              />
            ) : (
              <DataTable
                columns={columns}
                data={filteredServiceAccounts}
                onRowClick={(account, event) => {
                  const target = event.target as HTMLElement;
                  if (target.closest("a,button")) return;
                  router.push(`/settings/service-accounts/${account.id}`);
                }}
                emptyMessage="No service accounts yet"
                hasActiveFilters={search.trim().length > 0}
                filteredEmptyMessage="No service accounts match your search. Try adjusting your search."
                onClearFilters={() =>
                  updateQueryParams({ search: null, page: "1" })
                }
              />
            )}
          </div>
        </LoadingWrapper>
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
              <Input
                id="service-account-name"
                {...form.register("name", { required: true })}
                placeholder="Automation service account"
              />
              <p className="text-xs text-muted-foreground">
                The display name for this service account.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="service-account-role">Role</Label>
              <RoleSelect
                id="service-account-role"
                value={form.watch("role")}
                onValueChange={(role) => form.setValue("role", role)}
                placeholder="Select a role"
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                The role this service account will use for API requests.
              </p>
            </div>
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
        description="Deleting a service account immediately invalidates all of its tokens."
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}

function formatRoleName(role: string): string {
  return role
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
