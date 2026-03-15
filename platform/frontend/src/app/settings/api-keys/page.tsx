"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNowStrict } from "date-fns";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { CopyButton } from "@/components/copy-button";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions } from "@/lib/auth.query";
import {
  useApiKeys,
  useCreateApiKey,
  useDeleteApiKey,
  type UserApiKey,
} from "@/lib/api-key.query";
import { formatDate } from "@/lib/utils";

type CreateApiKeyFormValues = {
  name: string;
  expiresInDays: string;
};

const DEFAULT_FORM_VALUES: CreateApiKeyFormValues = {
  name: "",
  expiresInDays: "",
};

export default function ApiKeysSettingsPage() {
  const { data: apiKeys = [], isPending } = useApiKeys();
  const { data: canDeleteApiKeys } = useHasPermissions({ apiKey: ["delete"] });
  const createApiKeyMutation = useCreateApiKey();
  const deleteApiKeyMutation = useDeleteApiKey();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [apiKeyToDelete, setApiKeyToDelete] = useState<UserApiKey | null>(null);
  const [createdApiKeyValue, setCreatedApiKeyValue] = useState<string | null>(null);

  const form = useForm<CreateApiKeyFormValues>({
    defaultValues: DEFAULT_FORM_VALUES,
  });

  const columns: ColumnDef<UserApiKey>[] = useMemo(() => {
    const baseColumns: ColumnDef<UserApiKey>[] = [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => row.original.name || "Untitled key",
      },
      {
        accessorKey: "start",
        header: "Prefix",
        cell: ({ row }) => (
          <code className="text-xs font-mono">
            {row.original.start || row.original.prefix || "Hidden"}
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
        cell: ({ row }) => formatDate({ date: row.original.createdAt }),
      },
      {
        accessorKey: "lastRequest",
        header: "Last used",
        cell: ({ row }) =>
          row.original.lastRequest
            ? formatDistanceToNowStrict(new Date(row.original.lastRequest), {
                addSuffix: true,
              })
            : "Never",
      },
      {
        accessorKey: "expiresAt",
        header: "Expires",
        cell: ({ row }) =>
          row.original.expiresAt
            ? formatDate({ date: row.original.expiresAt })
            : "Never",
      },
    ];

    if (!canDeleteApiKeys) {
      return baseColumns;
    }

    return [
      ...baseColumns,
      {
        id: "actions",
        header: "",
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
    const expiresInDays = values.expiresInDays.trim();
    const expiresIn = expiresInDays ? Number(expiresInDays) * 24 * 60 * 60 : null;

    const createdApiKey = await createApiKeyMutation.mutateAsync({
      name: values.name.trim() || undefined,
      expiresIn: expiresIn && !Number.isNaN(expiresIn) ? expiresIn : null,
    });

    if (!createdApiKey) {
      return;
    }

    setCreatedApiKeyValue(createdApiKey.key);
    setIsCreateDialogOpen(false);
    form.reset(DEFAULT_FORM_VALUES);
  });

  const handleDelete = async () => {
    if (!apiKeyToDelete) return;
    await deleteApiKeyMutation.mutateAsync(apiKeyToDelete.id);
    setApiKeyToDelete(null);
  };

  return (
    <div className="space-y-6">
      {createdApiKeyValue && (
        <Alert>
          <KeyRound className="h-4 w-4" />
          <AlertTitle>Copy your new API key now</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>This is the only time Archestra will show the full key value.</p>
            <div className="flex gap-2">
              <Input readOnly value={createdApiKeyValue} className="font-mono text-xs" />
              <CopyButton text={createdApiKeyValue} />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setCreatedApiKeyValue(null)}
            >
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div className="space-y-1">
            <CardTitle>Archestra API Keys</CardTitle>
            <p className="text-sm text-muted-foreground">
              Manage personal API keys for MCP Gateway, A2A Gateway, and Archestra API access.
            </p>
          </div>
          <PermissionButton
            permissions={{ apiKey: ["create"] }}
            onClick={() => setIsCreateDialogOpen(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create API Key
          </PermissionButton>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={apiKeys}
              emptyMessage="No API keys yet"
            />
          )}
        </CardContent>
      </Card>

      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Create a new personal API key for programmatic access.
            </DialogDescription>
          </DialogHeader>
          <DialogForm onSubmit={handleCreate}>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" placeholder="CI token" {...form.register("name")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="expiresInDays">Expiration in days</Label>
                <Input
                  id="expiresInDays"
                  type="number"
                  min="1"
                  placeholder="Leave blank for no expiration"
                  {...form.register("expiresInDays")}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsCreateDialogOpen(false)}
                disabled={createApiKeyMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createApiKeyMutation.isPending}>
                Create
              </Button>
            </DialogFooter>
          </DialogForm>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!apiKeyToDelete}
        onOpenChange={(open) => !open && setApiKeyToDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete API key</DialogTitle>
            <DialogDescription>
              This will immediately revoke access for anything using this key.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setApiKeyToDelete(null)}
              disabled={deleteApiKeyMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteApiKeyMutation.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
