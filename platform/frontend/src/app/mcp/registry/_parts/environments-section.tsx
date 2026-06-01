"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ReinstallConfirmBar } from "@/components/reinstall-confirm-bar";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useFeature } from "@/lib/config/config.query";
import {
  type EnvironmentWithAssignedCount,
  type NamespaceTestResult,
  testNamespaceAccess,
  useCreateEnvironment,
  useDeleteEnvironment,
  useEnvironments,
  useUpdateEnvironment,
} from "@/lib/organization/environment.query";
import { useNetworkPolicies } from "@/lib/organization/network-policy.query";
import {
  useDefaultEnvironment,
  useUpdateDefaultEnvironment,
} from "@/lib/organization.query";
import { useSetMcpRegistryAction } from "../layout";

const NETWORK_POLICY_DEFAULT_VALUE = "__default_network_policy__";

type EnvironmentTableRow =
  | {
      kind: "default";
      id: "default";
      name: string;
      namespace: string | null;
      description: string | null;
      networkPolicyId: string | null;
      restricted: boolean;
      assignedCatalogCount: number;
    }
  | (EnvironmentWithAssignedCount & { kind: "environment" });

export function EnvironmentsSection({ canEdit }: { canEdit: boolean }) {
  const setActionButton = useSetMcpRegistryAction();
  const { data: environmentList, isLoading } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  const defaultAssignedCatalogCount =
    environmentList?.defaultAssignedCatalogCount ?? 0;
  const { data: networkPolicies = [] } = useNetworkPolicies();
  const defaultEnvironment = useDefaultEnvironment();
  const [createOpen, setCreateOpen] = useState(false);
  const [editDefaultOpen, setEditDefaultOpen] = useState(false);
  const [editTarget, setEditTarget] =
    useState<EnvironmentWithAssignedCount | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<EnvironmentWithAssignedCount | null>(null);

  useEffect(() => {
    setActionButton(
      <Button
        className="h-9 shrink-0 px-3 text-sm"
        disabled={!canEdit}
        onClick={() => setCreateOpen(true)}
      >
        <Plus className="h-4 w-4" />
        Add Environment
      </Button>,
    );

    return () => setActionButton(null);
  }, [canEdit, setActionButton]);

  const rows: EnvironmentTableRow[] = useMemo(
    () => [
      {
        kind: "default",
        id: "default",
        name: defaultEnvironment.name,
        namespace: defaultEnvironment.namespace,
        description: defaultEnvironment.description,
        networkPolicyId: defaultEnvironment.networkPolicyId,
        restricted: defaultEnvironment.restricted,
        assignedCatalogCount: defaultAssignedCatalogCount,
      },
      ...environments.map((environment) => ({
        ...environment,
        kind: "environment" as const,
      })),
    ],
    [defaultAssignedCatalogCount, defaultEnvironment, environments],
  );

  const columns: ColumnDef<EnvironmentTableRow>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <span className="flex items-center gap-2 font-medium">
            {row.original.name}
            {row.original.kind === "default" &&
              row.original.name !== "Default" && (
                <Badge variant="outline" className="text-muted-foreground">
                  Default
                </Badge>
              )}
          </span>
        ),
      },
      {
        accessorKey: "namespace",
        header: "Namespace",
        cell: ({ row }) => <NamespaceCell namespace={row.original.namespace} />,
      },
      {
        accessorKey: "networkPolicyId",
        header: "Network Policy",
        cell: ({ row }) => (
          <NetworkPolicyCell
            policyId={row.original.networkPolicyId}
            policies={networkPolicies}
            emptyLabel={
              row.original.kind === "default" ? "None" : "Use default"
            }
          />
        ),
      },
      {
        accessorKey: "assignedCatalogCount",
        header: "Assigned MCPs",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.assignedCatalogCount}
          </span>
        ),
      },
      {
        accessorKey: "restricted",
        header: "Access",
        cell: ({ row }) =>
          row.original.restricted ? (
            <Badge variant="secondary">Restricted</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              Open
            </Badge>
          ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <TableRowActions
              actions={[
                {
                  icon: <Pencil className="h-4 w-4" />,
                  label: `Edit ${item.name}`,
                  disabled: !canEdit,
                  onClick: () => {
                    if (item.kind === "default") {
                      setEditDefaultOpen(true);
                    } else {
                      setEditTarget(item);
                    }
                  },
                },
                ...(item.kind === "environment"
                  ? [
                      {
                        icon: <Trash2 className="h-4 w-4" />,
                        label: `Delete ${item.name}`,
                        variant: "destructive" as const,
                        disabled: !canEdit || item.assignedCatalogCount > 0,
                        disabledTooltip:
                          item.assignedCatalogCount > 0
                            ? "Reassign or remove the catalog items in this environment before deleting it."
                            : undefined,
                        onClick: () => setDeleteTarget(item),
                      },
                    ]
                  : []),
              ]}
            />
          );
        },
      },
    ],
    [canEdit, networkPolicies],
  );

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        emptyMessage="No environments"
      />

      <EnvironmentEditorDialog
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        environment={null}
        networkPolicies={networkPolicies}
      />

      <EnvironmentEditorDialog
        mode="edit"
        open={editTarget !== null}
        onOpenChange={(v) => !v && setEditTarget(null)}
        environment={editTarget}
        networkPolicies={networkPolicies}
      />

      <EnvironmentEditorDialog
        mode="default"
        open={editDefaultOpen}
        onOpenChange={setEditDefaultOpen}
        environment={null}
        defaultEnvironment={defaultEnvironment}
        networkPolicies={networkPolicies}
      />

      <DeleteEnvironmentDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/**
 * Renders an environment's namespace. When none is set, pods fall back to the
 * orchestrator's default namespace, so we surface that as a muted hint (only
 * when the K8s runtime is enabled — otherwise namespaces aren't applied).
 */
function NamespaceCell({ namespace }: { namespace: string | null }) {
  const runtimeEnabled = useFeature("orchestratorK8sRuntime");
  const orchestratorNamespace = useFeature("orchestratorK8sNamespace");

  if (namespace) {
    return (
      <span className="font-mono text-xs text-muted-foreground">
        {namespace}
      </span>
    );
  }

  if (runtimeEnabled && orchestratorNamespace) {
    return (
      <span
        className="font-mono text-xs text-muted-foreground/70 italic"
        title="Orchestrator default namespace (no namespace set on this environment)"
      >
        {orchestratorNamespace}
      </span>
    );
  }

  return <span className="text-muted-foreground">—</span>;
}

function NetworkPolicyCell({
  policyId,
  policies,
  emptyLabel,
}: {
  policyId: string | null;
  policies: Array<{ id: string; name: string }>;
  emptyLabel: string;
}) {
  if (!policyId) {
    return <span className="text-muted-foreground">{emptyLabel}</span>;
  }

  const policy = policies.find((p) => p.id === policyId);
  return <span className="text-sm">{policy?.name ?? "Unknown policy"}</span>;
}

const K8S_NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function validateNamespace(value: string): string | null {
  if (value === "") return null;
  if (value.length > 63) return "Must be 63 characters or fewer";
  if (!K8S_NAMESPACE_RE.test(value))
    return "Lowercase letters, numbers, and hyphens only; no leading or trailing hyphens";
  return null;
}

function EnvironmentEditorDialog({
  mode,
  open,
  onOpenChange,
  environment,
  defaultEnvironment,
  networkPolicies,
}: {
  // "default" edits the org-level default environment; "create"/"edit" manage
  // real environments. Name, description, namespace, and restricted are all
  // editable in every mode.
  mode: "create" | "edit" | "default";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: EnvironmentWithAssignedCount | null;
  defaultEnvironment?: {
    name: string;
    namespace: string | null;
    description: string | null;
    networkPolicyId: string | null;
    restricted: boolean;
  };
  networkPolicies: Array<{
    id: string;
    name: string;
    description: string | null;
  }>;
}) {
  const createMutation = useCreateEnvironment();
  const updateMutation = useUpdateEnvironment();
  const updateDefaultMutation = useUpdateDefaultEnvironment(
    "Default environment updated",
    "Failed to update default environment",
  );
  const runtimeEnabled = useFeature("orchestratorK8sRuntime");
  const orchestratorNamespace = useFeature("orchestratorK8sNamespace");

  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [description, setDescription] = useState("");
  const [networkPolicyId, setNetworkPolicyId] = useState<string | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [nsTest, setNsTest] = useState<
    "idle" | "pending" | NamespaceTestResult
  >("idle");
  // Sync drafts whenever the dialog (re)opens for a target.
  useEffect(() => {
    if (open) {
      setShowConfirm(false);
      setNsTest("idle");
      if (mode === "default") {
        setName(defaultEnvironment?.name ?? "");
        setNamespace(defaultEnvironment?.namespace ?? "");
        setDescription(defaultEnvironment?.description ?? "");
        setNetworkPolicyId(defaultEnvironment?.networkPolicyId ?? null);
        setRestricted(defaultEnvironment?.restricted ?? false);
      } else {
        setName(environment?.name ?? "");
        setNamespace(environment?.namespace ?? "");
        setDescription(environment?.description ?? "");
        setNetworkPolicyId(environment?.networkPolicyId ?? null);
        setRestricted(environment?.restricted ?? false);
      }
    }
  }, [open, mode, environment, defaultEnvironment]);

  const isPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    updateDefaultMutation.isPending;
  const trimmedName = name.trim();
  const trimmedNamespace = namespace.trim();
  const trimmedDescription = description.trim();
  const namespaceError = validateNamespace(trimmedNamespace);
  const canSave =
    !namespaceError && (mode === "edit" ? true : trimmedName.length > 0);

  const willRestart =
    mode === "edit" &&
    environment !== null &&
    environment.assignedCatalogCount > 0 &&
    trimmedNamespace !== (environment.namespace ?? "");

  const doSave = () => {
    const namespaceValue = trimmedNamespace === "" ? null : trimmedNamespace;
    const descriptionValue =
      trimmedDescription === "" ? null : trimmedDescription;
    if (mode === "create") {
      createMutation.mutate(
        {
          name: trimmedName,
          namespace: namespaceValue,
          description: descriptionValue,
          networkPolicyId,
          restricted,
        },
        { onSuccess: (created) => created && onOpenChange(false) },
      );
    } else if (mode === "default") {
      updateDefaultMutation.mutate(
        {
          name: trimmedName,
          namespace: namespaceValue,
          description: descriptionValue,
          networkPolicyId,
          restricted,
        },
        { onSuccess: (updated) => updated && onOpenChange(false) },
      );
    } else if (environment) {
      updateMutation.mutate(
        {
          id: environment.id,
          body: {
            name: trimmedName,
            namespace: namespaceValue,
            description: descriptionValue,
            networkPolicyId,
            restricted,
          },
        },
        { onSuccess: (updated) => updated && onOpenChange(false) },
      );
    }
  };

  const handleSave = () => {
    if (willRestart) {
      setShowConfirm(true);
    } else {
      doSave();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {mode === "create"
              ? "Add environment"
              : mode === "default"
                ? "Edit default environment"
                : "Edit environment"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Create an org-level deployment environment."
              : mode === "default"
                ? "Update the default environment."
                : "Update this environment."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="environment-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="environment-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production"
              maxLength={50}
              disabled={isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="environment-description">Description</Label>
            <Textarea
              id="environment-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              className="min-h-20"
              disabled={isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="environment-namespace">Namespace</Label>
            <div className="flex gap-2">
              <Input
                id="environment-namespace"
                value={namespace}
                onChange={(e) => {
                  setNamespace(e.target.value);
                  setShowConfirm(false);
                  setNsTest("idle");
                }}
                placeholder={
                  runtimeEnabled && orchestratorNamespace
                    ? orchestratorNamespace
                    : "e.g. prod-eu"
                }
                maxLength={63}
                disabled={isPending}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  !trimmedNamespace ||
                  !!namespaceError ||
                  nsTest === "pending" ||
                  isPending
                }
                onClick={async () => {
                  setNsTest("pending");
                  setNsTest(await testNamespaceAccess(trimmedNamespace));
                }}
              >
                {nsTest === "pending" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Test"
                )}
              </Button>
            </div>
            {namespaceError && (
              <p className="text-xs text-destructive">{namespaceError}</p>
            )}
            {nsTest !== "idle" && nsTest !== "pending" && (
              <p
                className={`flex items-center gap-1 text-xs ${nsTest.accessible ? "text-green-600 dark:text-green-400" : "text-destructive"}`}
              >
                {nsTest.accessible ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <XCircle className="h-3.5 w-3.5" />
                )}
                {nsTest.accessible ? "Namespace is accessible" : nsTest.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Network Policy</Label>
            <Select
              value={networkPolicyId ?? NETWORK_POLICY_DEFAULT_VALUE}
              onValueChange={(value) =>
                setNetworkPolicyId(
                  value === NETWORK_POLICY_DEFAULT_VALUE ? null : value,
                )
              }
              disabled={isPending}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NETWORK_POLICY_DEFAULT_VALUE}>
                  {mode === "default" ? "None" : "Use default policy"}
                </SelectItem>
                {networkPolicies.map((policy) => (
                  <SelectItem
                    key={policy.id}
                    value={policy.id}
                    description={policy.description ?? undefined}
                  >
                    {policy.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="environment-restricted">Restricted</Label>
              <p className="text-xs text-muted-foreground">
                Only users who hold the{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">
                  environment:admin
                </code>{" "}
                permission are allowed to deploy in this environment.
              </p>
            </div>
            <Switch
              id="environment-restricted"
              checked={restricted}
              onCheckedChange={setRestricted}
              disabled={isPending}
            />
          </div>
        </DialogBody>
        {showConfirm ? (
          <ReinstallConfirmBar
            mode="auto"
            affectedServerCount={environment?.assignedCatalogCount ?? 0}
            isSubmitting={isPending}
            onCancel={() => setShowConfirm(false)}
            onConfirm={doSave}
          />
        ) : (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!canSave || isPending}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeleteEnvironmentDialog({
  target,
  onClose,
}: {
  target: EnvironmentWithAssignedCount | null;
  onClose: () => void;
}) {
  const deleteMutation = useDeleteEnvironment();

  if (!target) return null;

  return (
    <DeleteConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${target.name}?`}
      description={
        <div className="space-y-2 text-sm">
          <p>
            This removes the <span className="font-medium">{target.name}</span>{" "}
            environment. This cannot be undone.
          </p>
        </div>
      }
      isPending={deleteMutation.isPending}
      pendingLabel="Deleting…"
      onConfirm={() =>
        deleteMutation.mutate(target.id, {
          onSuccess: () => onClose(),
        })
      }
    />
  );
}
