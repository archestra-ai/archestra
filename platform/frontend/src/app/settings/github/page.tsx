"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Info, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { SecretInput, SecretTextarea } from "@/components/ui/secret-input";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type GithubAppConfig,
  useCreateGithubAppConfig,
  useDeleteGithubAppConfig,
  useGithubAppConfig,
  useGithubAppConfigs,
  useUpdateGithubAppConfig,
} from "@/lib/github-app-config.query";
import {
  type GithubPat,
  useCreateGithubPat,
  useDeleteGithubPat,
  useGithubPats,
  useUpdateGithubPat,
} from "@/lib/github-pat.query";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { useSetSettingsAction } from "../layout";

const DEFAULT_GITHUB_URL = "https://api.github.com";

/** One row of the unified credentials table: a GitHub App config or a PAT. */
type CredentialRow =
  | {
      kind: "app";
      id: string;
      name: string;
      createdAt: string;
      app: GithubAppConfig;
    }
  | {
      kind: "pat";
      id: string;
      name: string;
      createdAt: string;
      pat: GithubPat;
    };

export default function GithubSettingsPage() {
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
  const { data: configs = [], isPending: isLoadingApps } =
    useGithubAppConfigs();
  const { data: pats = [], isPending: isLoadingPats } = useGithubPats();

  // the App edit dialog is deep-linkable via `?edit=<id>`; PAT dialogs and
  // the create dialog are plain local state.
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
  const [isAppCreateOpen, setIsAppCreateOpen] = useState(false);
  const [patDialog, setPatDialog] = useState<GithubPat | "new" | null>(null);
  const [rowToDelete, setRowToDelete] = useState<CredentialRow | null>(null);
  const appDialog: GithubAppConfig | "new" | null =
    editingConfig ?? (isAppCreateOpen ? "new" : null);
  // Cancel any pending `?edit=<id>` deep link before opening create, or the
  // by-id fetch could land and flip the create dialog into edit mode.
  const handleAppCreateOpen = useCallback(() => {
    closeEditDialog();
    setIsAppCreateOpen(true);
  }, [closeEditDialog]);
  const closeAppDialog = useCallback(() => {
    setIsAppCreateOpen(false);
    closeEditDialog();
  }, [closeEditDialog]);

  const rows: CredentialRow[] = useMemo(
    () =>
      [
        ...configs.map((app) => ({
          kind: "app" as const,
          id: app.id,
          name: app.name,
          createdAt: app.createdAt,
          app,
        })),
        ...pats.map((pat) => ({
          kind: "pat" as const,
          id: pat.id,
          name: pat.name,
          createdAt: pat.createdAt,
          pat,
        })),
      ].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [configs, pats],
  );

  useEffect(() => {
    setActionButton(
      <div className="flex items-center gap-2">
        <PermissionButton
          permissions={{ githubAppConfig: ["create"] }}
          variant="outline"
          onClick={() => setPatDialog("new")}
        >
          <KeyRound className="h-4 w-4" />
          Add token
        </PermissionButton>
        <PermissionButton
          permissions={{ githubAppConfig: ["create"] }}
          onClick={handleAppCreateOpen}
        >
          <Plus className="h-4 w-4" />
          Add GitHub App
        </PermissionButton>
      </div>,
    );
    return () => setActionButton(null);
  }, [setActionButton, handleAppCreateOpen]);

  const columns: ColumnDef<CredentialRow>[] = useMemo(() => {
    const baseColumns: ColumnDef<CredentialRow>[] = [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "type",
        header: "Type",
        cell: ({ row }) => (
          <Badge variant="outline">
            {row.original.kind === "app" ? "GitHub App" : "Token"}
          </Badge>
        ),
      },
      {
        id: "details",
        header: "Details",
        cell: ({ row }) => {
          if (row.original.kind === "pat") {
            return (
              <span className="text-sm text-muted-foreground">
                Personal access token
              </span>
            );
          }
          const { appId, installationId, githubUrl } = row.original.app;
          return (
            <span className="font-mono text-xs text-muted-foreground">
              App {appId} · Install {installationId}
              {githubUrl !== DEFAULT_GITHUB_URL ? ` · ${githubUrl}` : ""}
            </span>
          );
        },
      },
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
                      label: "Edit",
                      onClick: () =>
                        row.original.kind === "app"
                          ? openEditDialog(row.original.app)
                          : setPatDialog(row.original.pat),
                    },
                  ]
                : []),
              ...(canDelete
                ? [
                    {
                      icon: <Trash2 className="h-4 w-4" />,
                      label: "Delete",
                      onClick: () => setRowToDelete(row.original),
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

  return (
    <div className="space-y-6">
      <div className="flex gap-2.5 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>
          GitHub credentials — App configurations and personal access tokens —
          used by Knowledge Base (RAG) connectors, skill imports, and recurring
          skill sync. For an agentic integration, use the{" "}
          <Link
            href="/mcp/registry"
            className="font-medium text-foreground underline-offset-4 hover:underline"
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
            You do not have permission to view GitHub credentials.
          </AlertDescription>
        </Alert>
      ) : (
        <LoadingWrapper
          isPending={isLoadingApps || isLoadingPats}
          loadingFallback={<LoadingSpinner />}
        >
          <DataTable
            columns={columns}
            data={rows}
            getRowId={(row) => `${row.kind}-${row.id}`}
            emptyMessage="No GitHub credentials yet"
          />
        </LoadingWrapper>
      )}

      <GithubAppDialog dialogState={appDialog} onClose={closeAppDialog} />
      <GithubPatDialog dialogState={patDialog} onClose={setPatDialog} />
      <DeleteCredentialDialog row={rowToDelete} onClose={setRowToDelete} />
    </div>
  );
}

// ===== GitHub App dialog =====

type GithubAppConfigFormValues = {
  name: string;
  githubUrl: string;
  appId: string;
  installationId: string;
  privateKey: string;
};

function emptyAppFormValues(): GithubAppConfigFormValues {
  return {
    name: "",
    githubUrl: DEFAULT_GITHUB_URL,
    appId: "",
    installationId: "",
    privateKey: "",
  };
}

function GithubAppDialog({
  dialogState,
  onClose,
}: {
  dialogState: GithubAppConfig | "new" | null;
  onClose: (state: null) => void;
}) {
  const createConfig = useCreateGithubAppConfig();
  const updateConfig = useUpdateGithubAppConfig();
  const isEditing = dialogState !== null && dialogState !== "new";

  const form = useForm<GithubAppConfigFormValues>({
    defaultValues: emptyAppFormValues(),
  });

  useEffect(() => {
    if (dialogState === "new") {
      form.reset(emptyAppFormValues());
    } else if (dialogState) {
      form.reset({
        name: dialogState.name,
        githubUrl: dialogState.githubUrl,
        appId: dialogState.appId,
        installationId: dialogState.installationId,
        privateKey: "",
      });
    }
  }, [dialogState, form]);

  const handleSubmit = form.handleSubmit(async (values) => {
    if (isEditing) {
      // an empty private key leaves the stored one untouched
      const result = await updateConfig.mutateAsync({
        id: dialogState.id,
        data: {
          name: values.name,
          githubUrl: values.githubUrl,
          appId: values.appId,
          installationId: values.installationId,
          ...(values.privateKey.trim() && { privateKey: values.privateKey }),
        },
      });
      if (result) onClose(null);
      return;
    }

    const result = await createConfig.mutateAsync({
      name: values.name,
      githubUrl: values.githubUrl,
      appId: values.appId,
      installationId: values.installationId,
      privateKey: values.privateKey,
    });
    if (result) onClose(null);
  });

  return (
    <FormDialog
      open={dialogState !== null}
      onOpenChange={(open) => {
        if (!open) onClose(null);
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
                isEditing ? undefined : { required: "Private key is required" }
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
            <Button
              type="button"
              variant="outline"
              onClick={() => onClose(null)}
            >
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
  );
}

// ===== PAT dialog =====

type GithubPatFormValues = { name: string; token: string };

function GithubPatDialog({
  dialogState,
  onClose,
}: {
  dialogState: GithubPat | "new" | null;
  onClose: (state: null) => void;
}) {
  const createPat = useCreateGithubPat();
  const updatePat = useUpdateGithubPat();
  const isEditing = dialogState !== null && dialogState !== "new";

  const form = useForm<GithubPatFormValues>({
    defaultValues: { name: "", token: "" },
  });

  useEffect(() => {
    if (dialogState === "new") {
      form.reset({ name: "", token: "" });
    } else if (dialogState) {
      form.reset({ name: dialogState.name, token: "" });
    }
  }, [dialogState, form]);

  const handleSubmit = form.handleSubmit(async (values) => {
    if (isEditing) {
      // an empty token leaves the stored one untouched
      const result = await updatePat.mutateAsync({
        id: dialogState.id,
        data: {
          name: values.name,
          ...(values.token.trim() && { token: values.token.trim() }),
        },
      });
      if (result) onClose(null);
      return;
    }

    const result = await createPat.mutateAsync({
      name: values.name,
      token: values.token.trim(),
    });
    if (result) onClose(null);
  });

  return (
    <FormDialog
      open={dialogState !== null}
      onOpenChange={(open) => {
        if (!open) onClose(null);
      }}
      title={isEditing ? "Edit GitHub token" : "Add GitHub token"}
      size="small"
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
                    <Input placeholder="Skills repo token" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="token"
              rules={isEditing ? undefined : { required: "Token is required" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Token</FormLabel>
                  <FormControl>
                    <SecretInput
                      placeholder={
                        isEditing
                          ? "Leave empty to keep the existing token"
                          : "ghp_…"
                      }
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    A fine-grained token with read access to the repositories
                    you import skills from.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <DialogStickyFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onClose(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createPat.isPending || updatePat.isPending}
            >
              {isEditing ? "Save Changes" : "Save token"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </Form>
    </FormDialog>
  );
}

// ===== Delete confirm (both kinds) =====

function DeleteCredentialDialog({
  row,
  onClose,
}: {
  row: CredentialRow | null;
  onClose: (state: null) => void;
}) {
  const deleteConfig = useDeleteGithubAppConfig();
  const deletePat = useDeleteGithubPat();
  const isPending = deleteConfig.isPending || deletePat.isPending;

  const handleDelete = async () => {
    if (!row) return;
    const result =
      row.kind === "app"
        ? await deleteConfig.mutateAsync(row.id)
        : await deletePat.mutateAsync(row.id);
    if (result) onClose(null);
  };

  return (
    <DeleteConfirmDialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose(null);
      }}
      title={row?.kind === "app" ? "Delete GitHub App" : "Delete GitHub token"}
      description={
        row?.kind === "app" ? (
          <>
            This permanently deletes{" "}
            <span className="font-medium">{row?.name}</span> and its stored
            private key. Connectors and synced skills still using it must be
            reconfigured first.
          </>
        ) : (
          <>
            This permanently deletes{" "}
            <span className="font-medium">{row?.name}</span>. Synced skills
            still authenticating with it must be disconnected first.
          </>
        )
      }
      isPending={isPending}
      onConfirm={handleDelete}
    />
  );
}
