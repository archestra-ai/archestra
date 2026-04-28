"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useSetSettingsAction } from "@/app/settings/layout";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogForm, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  type Cluster,
  useClusters,
  useCreateCluster,
  useDeleteCluster,
  useTestCluster,
  useUpdateCluster,
} from "@/lib/clusters/cluster.query";

type ClusterFormValues = {
  name: string;
  namespace: string;
  kubeconfigYaml: string;
  loadFromCluster: boolean;
  isPersonalDefault: boolean;
};

const EMPTY_FORM: ClusterFormValues = {
  name: "",
  namespace: "",
  kubeconfigYaml: "",
  loadFromCluster: false,
  isPersonalDefault: false,
};

function clusterToFormValues(cluster: Cluster): ClusterFormValues {
  return {
    name: cluster.name,
    namespace: cluster.namespace ?? "",
    kubeconfigYaml: "",
    loadFromCluster: cluster.loadFromCluster,
    isPersonalDefault: cluster.isPersonalDefault,
  };
}

export default function ClustersSettingsPage() {
  const setActionButton = useSetSettingsAction();
  const { data: clusters = [], isLoading } = useClusters();
  const createMutation = useCreateCluster();
  const updateMutation = useUpdateCluster();
  const deleteMutation = useDeleteCluster();
  const testMutation = useTestCluster();

  const [editing, setEditing] = useState<Cluster | null>(null);
  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState<Cluster | null>(null);

  const form = useForm<ClusterFormValues>({ defaultValues: EMPTY_FORM });

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
    return () => setActionButton(null);
  }, [setActionButton]);

  const handleSubmit = form.handleSubmit(async (values) => {
    const trimmedName = values.name.trim();
    if (!trimmedName) return;

    const namespace = values.namespace.trim();
    const kubeconfigYaml = values.kubeconfigYaml.trim();

    if (editing) {
      await updateMutation.mutateAsync({
        id: editing.id,
        body: {
          name: trimmedName,
          namespace: namespace.length > 0 ? namespace : null,
          kubeconfigYaml: kubeconfigYaml.length > 0 ? kubeconfigYaml : null,
          loadFromCluster: values.loadFromCluster,
          isPersonalDefault: values.isPersonalDefault,
        },
      });
    } else {
      await createMutation.mutateAsync({
        name: trimmedName,
        namespace: namespace.length > 0 ? namespace : null,
        kubeconfigYaml: kubeconfigYaml.length > 0 ? kubeconfigYaml : undefined,
        loadFromCluster: values.loadFromCluster,
        isPersonalDefault: values.isPersonalDefault,
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

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <PermissionButton
          permissions={{ mcpServerInstallation: ["admin"] }}
          onClick={openCreate}
        >
          <Plus className="mr-2 h-4 w-4" />
          Create cluster
        </PermissionButton>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading clusters...</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Namespace</TableHead>
              <TableHead>Kubeconfig</TableHead>
              <TableHead>Personal default</TableHead>
              <TableHead className="w-[80px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedClusters.map((cluster) => {
              const kubeconfigSource = cluster.loadFromCluster
                ? "In-cluster"
                : cluster.kubeconfigSecretId
                  ? "Custom"
                  : cluster.isDefault
                    ? "Env / default"
                    : "Default";

              return (
                <TableRow key={cluster.id}>
                  <TableCell>
                    <button
                      type="button"
                      className="font-medium hover:underline text-left"
                      onClick={() => openEdit(cluster)}
                    >
                      {cluster.name}
                    </button>
                    {cluster.isDefault && (
                      <Badge variant="secondary" className="ml-2">
                        System
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {cluster.namespace ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {kubeconfigSource}
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label="Personal default"
                      checked={cluster.isPersonalDefault}
                      onCheckedChange={(next) =>
                        handleTogglePersonalDefault(cluster, next)
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Delete"
                      onClick={() => setToDelete(cluster)}
                      disabled={cluster.isDefault}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

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
              <Label htmlFor="cluster-scope">Scope</Label>
              <Input
                id="cluster-scope"
                placeholder="Kubernetes namespace (defaults to 'default')"
                {...form.register("namespace")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cluster-kubeconfig">Kubeconfig (YAML)</Label>
              <Textarea
                id="cluster-kubeconfig"
                placeholder="Paste kubeconfig YAML or leave blank"
                rows={8}
                {...form.register("kubeconfigYaml")}
              />
              <p className="text-xs text-muted-foreground">
                Leave blank to keep the existing kubeconfig (when editing) or to
                fall back to the platform default kubeconfig.
              </p>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="space-y-1">
                <Label htmlFor="cluster-in-cluster">
                  Load kubeconfig from current cluster
                </Label>
                <p className="text-xs text-muted-foreground">
                  Use the platform pod&apos;s in-cluster service account.
                </p>
              </div>
              <Switch
                id="cluster-in-cluster"
                aria-label="Load kubeconfig from current cluster"
                checked={form.watch("loadFromCluster")}
                onCheckedChange={(value) =>
                  form.setValue("loadFromCluster", value)
                }
              />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="space-y-1">
                <Label htmlFor="cluster-personal-default">
                  Use as personal default
                </Label>
                <p className="text-xs text-muted-foreground">
                  Personal MCP servers without an explicit cluster will be
                  deployed here.
                </p>
              </div>
              <Switch
                id="cluster-personal-default"
                aria-label="Use as personal default"
                checked={form.watch("isPersonalDefault")}
                onCheckedChange={(value) =>
                  form.setValue("isPersonalDefault", value)
                }
              />
            </div>
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
