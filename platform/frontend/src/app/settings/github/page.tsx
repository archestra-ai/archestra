"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DialogForm, DialogStickyFooter } from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PermissionButton } from "@/components/ui/permission-button";
import { SecretTextarea } from "@/components/ui/secret-input";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type GithubAppConfig,
  useCreateGithubAppConfig,
  useDeleteGithubAppConfig,
  useGithubAppConfig,
  useGithubAppConfigs,
  useUpdateGithubAppConfig,
} from "@/lib/github-app-config.query";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { useSetSettingsAction } from "../layout";

const DEFAULT_GITHUB_URL = "https://api.github.com";

type GithubAppConfigFormValues = {
  name: string;
  githubUrl: string;
  appId: string;
  installationId: string;
  privateKey: string;
};

function emptyFormValues(): GithubAppConfigFormValues {
  return {
    name: "",
    githubUrl: DEFAULT_GITHUB_URL,
    appId: "",
    installationId: "",
    privateKey: "",
  };
}

export default function GithubAppsSettingsPage() {
  const setActionButton = useSetSettingsAction();
  const { data: canRead, isPending: isCheckingPermissions } = useHasPermissions(
    { githubAppConfig: ["read"] },
  );
  const { data: canUpdate } = useHasPermissions({
    githubAppConfig: ["update"],
  });
  const { data: canDelete } = useHasPermissions({
    githubAppConfig: ["delete"],
  });
  const { data: configs = [], isPending } = useGithubAppConfigs();
  const createConfig = useCreateGithubAppConfig();
  const updateConfig = useUpdateGithubAppConfig();
  const deleteConfig = useDeleteGithubAppConfig();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [configToDelete, setConfigToDelete] = useState<GithubAppConfig | null>(
    null,
  );

  const searchParams = useSearchParams();
  const editId = searchParams.get("edit");
  const { data: editingConfigFromUrl } = useGithubAppConfig(
    editId ?? undefined,
  );

  const {
    entity: editingConfig,
    open: openEditDialog,
    close: closeEditDialog,
  } = useDialogUrlParam<GithubAppConfig>({
    paramName: "edit",
    entityFromUrl: editingConfigFromUrl ?? null,
  });

  const form = useForm<GithubAppConfigFormValues>({
    defaultValues: emptyFormValues(),
  });

  const isEditing = editingConfig !== null;

  // Cancel any pending `?edit=<id>` deep link before opening create, or the
  // by-id fetch could land and flip the create dialog into edit mode.
  const handleCreateOpen = useCallback(() => {
    closeEditDialog();
    setIsCreateDialogOpen(true);
  }, [closeEditDialog]);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ githubAppConfig: ["create"] }}
        onClick={handleCreateOpen}
      >
        <Plus className="h-4 w-4" />
        Add GitHub App
      </PermissionButton>,
    );
    return () => setActionButton(null);
  }, [setActionButton, handleCreateOpen]);

  useEffect(() => {
    if (isCreateDialogOpen) {
      form.reset(emptyFormValues());
    } else if (editingConfig) {
      form.reset({
        name: editingConfig.name,
        githubUrl: editingConfig.githubUrl,
        appId: editingConfig.appId,
        installationId: editingConfig.installationId,
        privateKey: "",
      });
    }
  }, [isCreateDialogOpen, editingConfig, form]);

  const columns: ColumnDef<GithubAppConfig>[] = useMemo(() => {
    const baseColumns: ColumnDef<GithubAppConfig>[] = [
      { accessorKey: "name", header: "Name" },
      {
        accessorKey: "appId",
        header: "App ID",
        cell: ({ row }) => (
          <code className="text-xs font-mono">{row.original.appId}</code>
        ),
      },
      {
        accessorKey: "installationId",
        header: "Installation ID",
        cell: ({ row }) => (
          <code className="text-xs font-mono">
            {row.original.installationId}
          </code>
        ),
      },
      { accessorKey: "githubUrl", header: "GitHub API URL" },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => formatRelativeTimeFromNow(row.original.createdAt),
      },
    ];

    if (!canUpdate && !canDelete) return baseColumns;

    return [
      ...baseColumns,
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <TableRowActions
            actions={[
              ...(canUpdate
                ? [
                    {
                      icon: <Pencil className="h-4 w-4" />,
                      label: "Edit configuration",
                      onClick: () => openEditDialog(row.original),
                    },
                  ]
                : []),
              ...(canDelete
                ? [
                    {
                      icon: <Trash2 className="h-4 w-4" />,
                      label: "Delete configuration",
                      onClick: () => setConfigToDelete(row.original),
                      variant: "destructive" as const,
                    },
                  ]
                : []),
            ]}
          />
        ),
      },
    ];
  }, [canUpdate, canDelete, openEditDialog]);

  const closeDialog = () => {
    if (editingConfig) {
      closeEditDialog();
    } else {
      setIsCreateDialogOpen(false);
    }
  };

  const handleSubmit = form.handleSubmit(async (values) => {
    if (editingConfig) {
      // an empty private key leaves the stored one untouched
      const result = await updateConfig.mutateAsync({
        id: editingConfig.id,
        data: {
          name: values.name,
          githubUrl: values.githubUrl,
          appId: values.appId,
          installationId: values.installationId,
          ...(values.privateKey.trim() && { privateKey: values.privateKey }),
        },
      });
      if (result) closeEditDialog();
      return;
    }

    const result = await createConfig.mutateAsync({
      name: values.name,
      githubUrl: values.githubUrl,
      appId: values.appId,
      installationId: values.installationId,
      privateKey: values.privateKey,
    });
    if (result) setIsCreateDialogOpen(false);
  });

  const handleDelete = async () => {
    if (!configToDelete) return;
    const result = await deleteConfig.mutateAsync(configToDelete.id);
    if (result) setConfigToDelete(null);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-muted/40 px-5 py-4">
        <p className="text-base leading-7 text-muted-foreground">
          System integration between{" "}
          <span className="font-medium text-foreground">Archestra.AI</span> and{" "}
          <span className="font-medium text-foreground">GitHub</span> — used by
          Knowledge Base (RAG) connectors and Skill sync. For an agentic
          integration, use the{" "}
          <Link
            href="/mcp/registry"
            className="font-medium text-foreground underline decoration-primary decoration-2 underline-offset-4 hover:text-primary"
          >
            GitHub MCP server
          </Link>{" "}
          instead.
        </p>
      </div>
      {!isCheckingPermissions && !canRead ? (
        <Alert variant="destructive">
          <AlertTitle>Access denied</AlertTitle>
          <AlertDescription>
            You do not have permission to view GitHub App configurations.
          </AlertDescription>
        </Alert>
      ) : (
        <LoadingWrapper
          isPending={isPending}
          loadingFallback={<LoadingSpinner />}
        >
          <DataTable
            columns={columns}
            data={configs}
            emptyMessage="No GitHub App configurations yet"
          />
        </LoadingWrapper>
      )}

      <FormDialog
        open={isCreateDialogOpen || isEditing}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title={isEditing ? "Edit GitHub App" : "Add GitHub App"}
        size="medium"
      >
        <Form {...form}>
          <DialogForm
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={handleSubmit}
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
              <FormField
                control={form.control}
                name="name"
                rules={{ required: "Name is required" }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Platform skills app" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="githubUrl"
                rules={{ required: "GitHub API URL is required" }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>GitHub API URL</FormLabel>
                    <FormControl>
                      <Input placeholder={DEFAULT_GITHUB_URL} {...field} />
                    </FormControl>
                    <FormDescription>
                      Use {DEFAULT_GITHUB_URL} for GitHub.com, or your GitHub
                      Enterprise API URL.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="appId"
                rules={{ required: "App ID is required" }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>App ID</FormLabel>
                    <FormControl>
                      <Input placeholder="123456" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="installationId"
                rules={{ required: "Installation ID is required" }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Installation ID</FormLabel>
                    <FormControl>
                      <Input placeholder="98765432" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="privateKey"
                rules={
                  isEditing
                    ? undefined
                    : { required: "Private key is required" }
                }
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Private Key</FormLabel>
                    <FormControl>
                      <SecretTextarea
                        placeholder={
                          isEditing
                            ? "Leave empty to keep the existing private key"
                            : "Paste the GitHub App private key PEM"
                        }
                        rows={6}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <DialogStickyFooter className="mt-0">
              <Button type="button" variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createConfig.isPending || updateConfig.isPending}
              >
                {isEditing ? "Save Changes" : "Create"}
              </Button>
            </DialogStickyFooter>
          </DialogForm>
        </Form>
      </FormDialog>

      <DeleteConfirmDialog
        open={configToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfigToDelete(null);
        }}
        title="Delete GitHub App configuration"
        description={
          <>
            This permanently deletes{" "}
            <span className="font-medium">{configToDelete?.name}</span> and its
            stored private key. Connectors still using it must be reconfigured
            first.
          </>
        }
        isPending={deleteConfig.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}
