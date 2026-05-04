"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { CopyButton } from "@/components/copy-button";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { FormDialog } from "@/components/form-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DialogForm, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  type UserApiKey,
  useApiKeys,
  useCreateApiKey,
  useDeleteApiKey,
} from "@/lib/api-key.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { formatDate } from "@/lib/utils";
import {
  formatRelativeTime,
  formatRelativeTimeFromNow,
} from "@/lib/utils/date-time";
import { useSetSettingsAction } from "../layout";
import { shouldSkipCreateApiKeySubmit } from "./page.utils";

type CreateApiKeyFormValues = {
  name: string;
  expiresAt: Date | null;
};

const DEFAULT_FORM_VALUES: CreateApiKeyFormValues = {
  name: "",
  expiresAt: null,
};

export default function ApiKeysSettingsPage() {
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const setActionButton = useSetSettingsAction();
  const { data: canReadApiKeys, isPending: isCheckingPermissions } =
    useHasPermissions({ apiKey: ["read"] });
  const { data: apiKeys = [], isPending } = useApiKeys();
  const { data: canDeleteApiKeys } = useHasPermissions({ apiKey: ["delete"] });
  const createApiKeyMutation = useCreateApiKey();
  const deleteApiKeyMutation = useDeleteApiKey();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [apiKeyToDelete, setApiKeyToDelete] = useState<UserApiKey | null>(null);
  const [createdApiKeyValue, setCreatedApiKeyValue] = useState<string | null>(
    null,
  );
  const hasSubmittedCreateDialogRef = useRef(false);
  const search = searchParams.get("search") || "";

  const form = useForm<CreateApiKeyFormValues>({
    defaultValues: DEFAULT_FORM_VALUES,
  });

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ apiKey: ["create"] }}
        onClick={() => setIsCreateDialogOpen(true)}
      >
        <Plus className="h-4 w-4" />
        Create API Key
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [setActionButton]);

  const filteredApiKeys = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return apiKeys;

    return apiKeys.filter((apiKey) =>
      (apiKey.name ?? "").toLowerCase().includes(query),
    );
  }, [apiKeys, search]);

  const columns: ColumnDef<UserApiKey>[] = useMemo(() => {
    const baseColumns: ColumnDef<UserApiKey>[] = [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => row.original.name || "Untitled key",
      },
      {
        accessorKey: "start",
        header: "Token",
        cell: ({ row }) => (
          <code className="text-xs font-mono">
            {row.original.start || row.original.prefix
              ? `${row.original.start || row.original.prefix}...`
              : "Hidden"}
          </code>
        ),
      },
      {
        accessorKey: "enabled",
        header: "Status",
        cell: ({ row }) =>
          row.original.enabled ? (
            <Badge variant="secondary">Active</Badge>
          ) : (
            <Badge variant="outline">Disabled</Badge>
          ),
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => formatRelativeTimeFromNow(row.original.createdAt),
      },
      {
        accessorKey: "lastRequest",
        header: "Last used",
        cell: ({ row }) => formatRelativeTimeFromNow(row.original.lastRequest),
      },
      {
        accessorKey: "expiresAt",
        header: "Expires",
        cell: ({ row }) => formatRelativeTime(row.original.expiresAt),
      },
    ];

    if (!canDeleteApiKeys) {
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
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete API key",
                onClick: () => setApiKeyToDelete(row.original),
                variant: "destructive",
              },
            ]}
          />
        ),
      },
    ];
  }, [canDeleteApiKeys]);

  const handleCreate = form.handleSubmit(async (values) => {
    if (
      shouldSkipCreateApiKeySubmit({
        hasSubmittedForCurrentDialogOpen: hasSubmittedCreateDialogRef.current,
        isCreatePending: createApiKeyMutation.isPending,
        createdApiKeyValue,
      })
    ) {
      return;
    }

    hasSubmittedCreateDialogRef.current = true;
    const expiresIn = values.expiresAt
      ? Math.max(
          1,
          Math.floor((values.expiresAt.getTime() - Date.now()) / 1000),
        )
      : null;

    const createdApiKey = await createApiKeyMutation.mutateAsync({
      name: values.name.trim() || undefined,
      expiresIn: expiresIn && !Number.isNaN(expiresIn) ? expiresIn : null,
    });

    if (!createdApiKey) {
      hasSubmittedCreateDialogRef.current = false;
      return;
    }

    setCreatedApiKeyValue(createdApiKey.key);
    form.reset(DEFAULT_FORM_VALUES);
  });

  const handleDelete = async () => {
    if (!apiKeyToDelete) return;
    await deleteApiKeyMutation.mutateAsync(apiKeyToDelete.id);
    setApiKeyToDelete(null);
  };

  return (
    <div className="space-y-6">
      {!isCheckingPermissions && !canReadApiKeys ? (
        <Alert variant="destructive">
          <AlertTitle>Access denied</AlertTitle>
          <AlertDescription>
            You do not have permission to view API keys.
          </AlertDescription>
        </Alert>
      ) : (
        <LoadingWrapper
          isPending={isPending}
          loadingFallback={<LoadingSpinner />}
        >
          <div className="space-y-4">
            <SearchInput
              objectNamePlural="API keys"
              searchFields={["key name"]}
            />
            <DataTable
              columns={columns}
              data={filteredApiKeys}
              emptyMessage="No API keys yet"
              hasActiveFilters={search.trim().length > 0}
              filteredEmptyMessage="No API keys match your search. Try adjusting your search."
              onClearFilters={() =>
                updateQueryParams({ search: null, page: "1" })
              }
            />
          </div>
        </LoadingWrapper>
      )}

      <FormDialog
        open={isCreateDialogOpen}
        onOpenChange={(open) => {
          setIsCreateDialogOpen(open);
          if (!open) {
            hasSubmittedCreateDialogRef.current = false;
            setCreatedApiKeyValue(null);
            form.reset(DEFAULT_FORM_VALUES);
          }
        }}
        title={createdApiKeyValue ? "API key created" : "Create API key"}
        description={
          createdApiKeyValue
            ? "Copy this key now. It will not be shown again after you close this dialog."
            : "Create a new personal API key for programmatic access."
        }
        size={createdApiKeyValue ? "small" : "medium"}
        className={createdApiKeyValue ? undefined : "sm:max-w-lg"}
      >
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={handleCreate}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {createdApiKeyValue ? (
              <>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <KeyRound className="h-4 w-4" />
                  Copy this key now. It won&apos;t be shown again.
                </div>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={createdApiKeyValue}
                    className="font-mono text-xs"
                  />
                  <CopyButton text={createdApiKeyValue} />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    placeholder="CI token"
                    {...form.register("name")}
                  />
                </div>
                <ExpirationDateTimeField
                  value={form.watch("expiresAt")}
                  onChange={(value) => form.setValue("expiresAt", value)}
                  noExpirationText="Key will never expire"
                  formatExpiration={(value) =>
                    value
                      ? formatDate({ date: new Date(value).toISOString() })
                      : ""
                  }
                />
              </>
            )}
          </div>
          <DialogStickyFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                hasSubmittedCreateDialogRef.current = false;
                setIsCreateDialogOpen(false);
                setCreatedApiKeyValue(null);
                form.reset(DEFAULT_FORM_VALUES);
              }}
              disabled={createApiKeyMutation.isPending}
            >
              {createdApiKeyValue ? "Close" : "Cancel"}
            </Button>
            {!createdApiKeyValue && (
              <Button type="submit" disabled={createApiKeyMutation.isPending}>
                Create
              </Button>
            )}
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      <DeleteConfirmDialog
        open={!!apiKeyToDelete}
        onOpenChange={(open) => !open && setApiKeyToDelete(null)}
        title="Delete API Key"
        description="This will immediately revoke access for anything using this key."
        isPending={deleteApiKeyMutation.isPending}
        onConfirm={handleDelete}
        confirmLabel="Delete"
        pendingLabel="Deleting..."
      />
    </div>
  );
}
