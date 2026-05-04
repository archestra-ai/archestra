"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useSetSettingsAction } from "@/app/settings/layout";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DialogForm, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type Cluster,
  useClusters,
  useCreateCluster,
  useDeleteCluster,
  useTestCluster,
  useUpdateCluster,
} from "@/lib/clusters/cluster.query";

type KubeconfigSource = "in-cluster" | "custom" | "default";

type ClusterFormValues = {
  name: string;
  namespace: string;
  kubeconfigYaml: string;
  kubeconfigSource: KubeconfigSource;
};

const EMPTY_FORM: ClusterFormValues = {
  name: "",
  namespace: "",
  kubeconfigYaml: "",
  kubeconfigSource: "default",
};

function clusterToFormValues(cluster: Cluster): ClusterFormValues {
  let source: KubeconfigSource;
  if (cluster.loadFromCluster) {
    source = "in-cluster";
  } else if (cluster.kubeconfigSecretId) {
    source = "custom";
  } else {
    source = "default";
  }

  return {
    name: cluster.name,
    namespace: cluster.namespace ?? "",
    kubeconfigYaml: "",
    kubeconfigSource: source,
  };
}

export default function ClustersSettingsPage() {
  const setActionButton = useSetSettingsAction();
  const { data: clusters = [], isLoading } = useClusters();
  const { data: canManageClusters = false } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const createMutation = useCreateCluster();
  const updateMutation = useUpdateCluster();
  const deleteMutation = useDeleteCluster();
  const testMutation = useTestCluster();

  const [editing, setEditing] = useState<Cluster | null>(null);
  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState<Cluster | null>(null);

  const form = useForm<ClusterFormValues>({ defaultValues: EMPTY_FORM });
  const kubeconfigSource = form.watch("kubeconfigSource");

  const dialogOpen = creating || editing !== null;

  const openCreate = () => {
    form.reset(EMPTY_FORM);
    setEditing(null);
    setCreating(true);
  };

  const openEdit = (cluster: Cluster) => {
    form.reset(clusterToFormValues(cluster));
    setCreating(false);
    setEditing(cluster);
  };

  const closeDialog = () => {
    setCreating(false);
    setEditing(null);
    form.reset(EMPTY_FORM);
  };

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ mcpServerInstallation: ["admin"] }}
        onClick={openCreate}
      >
        <Plus className="h-4 w-4" />
        Create cluster
      </PermissionButton>,
    );

    return () => setActionButton(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setActionButton]);

  const handleSubmit = form.handleSubmit(async (values) => {
    const trimmedName = values.name.trim();
    if (!trimmedName) return;

    const namespace = values.namespace.trim();
    const trimmedKubeconfigYaml = values.kubeconfigYaml.trim();

    const loadFromCluster = values.kubeconfigSource === "in-cluster";
    const kubeconfigYamlForUpdate =
      values.kubeconfigSource === "custom"
        ? trimmedKubeconfigYaml.length > 0
          ? trimmedKubeconfigYaml
          : undefined
        : null;
    const kubeconfigYamlForCreate =
      values.kubeconfigSource === "custom" && trimmedKubeconfigYaml.length > 0
        ? trimmedKubeconfigYaml
        : undefined;

    if (editing) {
      const updateBody: {
        name: string;
        namespace: string | null;
        loadFromCluster: boolean;
        kubeconfigYaml?: string | null;
      } = {
        name: trimmedName,
        namespace: namespace.length > 0 ? namespace : null,
        loadFromCluster,
      };
      if (kubeconfigYamlForUpdate !== undefined) {
        updateBody.kubeconfigYaml = kubeconfigYamlForUpdate;
      }
      await updateMutation.mutateAsync({
        id: editing.id,
        body: updateBody,
      });
    } else {
      await createMutation.mutateAsync({
        name: trimmedName,
        namespace: namespace.length > 0 ? namespace : null,
        kubeconfigYaml: kubeconfigYamlForCreate,
        loadFromCluster,
        isPersonalDefault: false,
      });
    }

    closeDialog();
  });

  const handleTogglePersonalDefault = async (
    cluster: Cluster,
    next: boolean,
  ) => {
    if (cluster.isPersonalDefault === next) return;
    await updateMutation.mutateAsync({
      id: cluster.id,
      body: { isPersonalDefault: next },
    });
  };

  const handleConfirmDelete = async () => {
    if (!toDelete) return;
    await deleteMutation.mutateAsync(toDelete.id);
    setToDelete(null);
  };

  const handleTestConnection = async () => {
    if (!editing) return;
    await testMutation.mutateAsync(editing.id);
  };

  const sortedClusters = useMemo(
    () =>
      [...clusters].sort((a, b) => {
        if (a.isDefault) return -1;
        if (b.isDefault) return 1;
        return a.name.localeCompare(b.name);
      }),
    [clusters],
  );

  const columns: ColumnDef<Cluster>[] = useMemo(() => {
    const baseColumns: ColumnDef<Cluster>[] = [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-medium">{row.original.name}</span>
            {row.original.isDefault && (
              <Badge variant="secondary">System</Badge>
            )}
          </div>
        ),
      },
      {
        accessorKey: "namespace",
        header: "Namespace",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.namespace ?? "—"}
          </span>
        ),
      },
      {
        id: "kubeconfig",
        header: "Kubeconfig",
        cell: ({ row }) => {
          const cluster = row.original;
          const label = cluster.loadFromCluster
            ? "In-cluster"
            : cluster.kubeconfigSecretId
              ? "Custom"
              : cluster.isDefault
                ? "Env / default"
                : "Default";
          return (
            <span className="text-sm text-muted-foreground">{label}</span>
          );
        },
      },
      {
        id: "personalDefault",
        header: "Personal default",
        cell: ({ row }) => (
          <Switch
            aria-label="Personal default"
            checked={row.original.isPersonalDefault}
            onCheckedChange={(next) =>
              handleTogglePersonalDefault(row.original, next)
            }
          />
        ),
      },
    ];

    if (!canManageClusters) {
      return baseColumns;
    }

    return [
      ...baseColumns,
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          if (row.original.isDefault) {
            return <TableRowActions actions={[]} />;
          }
          return (
            <TableRowActions
              actions={[
                {
                  icon: <Pencil className="h-4 w-4" />,
                  label: "Edit cluster",
                  onClick: () => openEdit(row.original),
                },
                {
                  icon: <Trash2 className="h-4 w-4" />,
                  label: "Delete cluster",
                  onClick: () => setToDelete(row.original),
                  variant: "destructive",
                },
              ]}
            />
          );
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManageClusters]);

  return (
    <div className="space-y-6">
      <LoadingWrapper
        isPending={isLoading}
        loadingFallback={<LoadingSpinner />}
      >
        <DataTable
          columns={columns}
          data={sortedClusters}
          emptyMessage="No clusters yet"
        />
      </LoadingWrapper>

      <FormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title={editing ? "Edit cluster" : "Add cluster"}
        description={
          editing
            ? "Update cluster connection details."
            : "Register a Kubernetes cluster where MCP servers can be deployed."
        }
      >
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={handleSubmit}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cluster-name">Name</Label>
              <Input
                id="cluster-name"
                placeholder="production"
                {...form.register("name", { required: true })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cluster-namespace">Namespace</Label>
              <Input
                id="cluster-namespace"
                placeholder="default"
                {...form.register("namespace")}
              />
              <p className="text-xs text-muted-foreground">
                Optional. Defaults to <code>default</code>.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cluster-kubeconfig-source">
                Kubeconfig source
              </Label>
              <Select
                value={kubeconfigSource}
                onValueChange={(value) =>
                  form.setValue(
                    "kubeconfigSource",
                    value as KubeconfigSource,
                  )
                }
              >
                <SelectTrigger
                  id="cluster-kubeconfig-source"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="in-cluster">
                    In-cluster service account
                  </SelectItem>
                  <SelectItem value="custom">
                    Custom kubeconfig (YAML)
                  </SelectItem>
                  <SelectItem value="default">Platform default</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {kubeconfigSource === "custom" && (
              <div className="space-y-2">
                <Label htmlFor="cluster-kubeconfig">Kubeconfig (YAML)</Label>
                <Textarea
                  id="cluster-kubeconfig"
                  placeholder="Paste kubeconfig YAML"
                  rows={8}
                  {...form.register("kubeconfigYaml")}
                />
                {editing && (
                  <p className="text-xs text-muted-foreground">
                    Leave blank to keep the existing kubeconfig.
                  </p>
                )}
              </div>
            )}
            {editing && (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={testMutation.isPending}
                >
                  {testMutation.isPending ? "Testing..." : "Test connection"}
                </Button>
                {testMutation.data && (
                  <span
                    className={
                      testMutation.data.ok
                        ? "text-sm text-green-600"
                        : "text-sm text-destructive"
                    }
                  >
                    {testMutation.data.ok
                      ? `OK${
                          testMutation.data.namespacesVisible !== undefined
                            ? ` — ${testMutation.data.namespacesVisible} namespaces visible`
                            : ""
                        }`
                      : (testMutation.data.error ?? "Connection failed")}
                  </span>
                )}
              </div>
            )}
          </div>
          <DialogStickyFooter>
            <Button type="button" variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {editing ? "Save" : "Create"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      <DeleteConfirmDialog
        open={!!toDelete}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title="Delete cluster"
        description={
          toDelete
            ? `Delete cluster "${toDelete.name}"? MCP servers pinned to this cluster will fall back to the default.`
            : ""
        }
        isPending={deleteMutation.isPending}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
