"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ReinstallConfirmBar } from "@/components/reinstall-confirm-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useFeature } from "@/lib/config/config.query";
import {
  type EnvironmentWithAssignedCount,
  useCreateEnvironment,
  useDeleteEnvironment,
  useEnvironments,
  useUpdateEnvironment,
} from "@/lib/organization/environment.query";
import {
  useDefaultEnvironment,
  useUpdateDefaultEnvironment,
} from "@/lib/organization.query";

export function EnvironmentsSection({ canEdit }: { canEdit: boolean }) {
  const { data: environmentList, isLoading } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  const defaultAssignedCatalogCount =
    environmentList?.defaultAssignedCatalogCount ?? 0;
  const defaultEnvironment = useDefaultEnvironment();
  const [createOpen, setCreateOpen] = useState(false);
  const [editDefaultOpen, setEditDefaultOpen] = useState(false);
  const [editTarget, setEditTarget] =
    useState<EnvironmentWithAssignedCount | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<EnvironmentWithAssignedCount | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-4">
        <Button
          size="sm"
          className="h-9 shrink-0 px-3 text-sm"
          disabled={!canEdit}
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          Add Environment
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Namespace</TableHead>
              <TableHead>Assigned MCPs</TableHead>
              <TableHead>Access</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* The Default environment is a real, configurable target (stored
                on the organization). It always renders first and cannot be
                deleted. */}
            <TableRow>
              <TableCell className="font-medium">
                <span className="flex items-center gap-2">
                  {defaultEnvironment.name}
                  {defaultEnvironment.name !== "Default" && (
                    <Badge variant="outline" className="text-muted-foreground">
                      Default
                    </Badge>
                  )}
                </span>
              </TableCell>
              <TableCell>
                <NamespaceCell namespace={defaultEnvironment.namespace} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {defaultAssignedCatalogCount}
              </TableCell>
              <TableCell>
                {defaultEnvironment.restricted ? (
                  <Badge variant="secondary">Restricted</Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">
                    Open
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  disabled={!canEdit}
                  onClick={() => setEditDefaultOpen(true)}
                  aria-label={`Edit ${defaultEnvironment.name}`}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-sm text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : (
              environments.map((environment) => (
                <TableRow key={environment.id}>
                  <TableCell className="font-medium">
                    {environment.name}
                  </TableCell>
                  <TableCell>
                    <NamespaceCell namespace={environment.namespace} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {environment.assignedCatalogCount}
                  </TableCell>
                  <TableCell>
                    {environment.restricted ? (
                      <Badge variant="secondary">Restricted</Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-muted-foreground"
                      >
                        Open
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      disabled={!canEdit}
                      onClick={() => setEditTarget(environment)}
                      aria-label={`Edit ${environment.name}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={
                        !canEdit || environment.assignedCatalogCount > 0
                      }
                      title={
                        environment.assignedCatalogCount > 0
                          ? "Reassign or remove the catalog items in this environment before deleting it."
                          : undefined
                      }
                      onClick={() => setDeleteTarget(environment)}
                      aria-label={`Delete ${environment.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <EnvironmentEditorDialog
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        environment={null}
      />

      <EnvironmentEditorDialog
        mode="edit"
        open={editTarget !== null}
        onOpenChange={(v) => !v && setEditTarget(null)}
        environment={editTarget}
      />

      <EnvironmentEditorDialog
        mode="default"
        open={editDefaultOpen}
        onOpenChange={setEditDefaultOpen}
        environment={null}
        defaultEnvironment={defaultEnvironment}
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

// Sentinel for the "use default" namespace option (maps to a null namespace —
// the environment inherits the org default). shadcn Select can't use "".
const NAMESPACE_DEFAULT_VALUE = "__default_namespace__";

function EnvironmentEditorDialog({
  mode,
  open,
  onOpenChange,
  environment,
  defaultEnvironment,
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
    restricted: boolean;
  };
}) {
  const createMutation = useCreateEnvironment();
  const updateMutation = useUpdateEnvironment();
  const updateDefaultMutation = useUpdateDefaultEnvironment(
    "Default environment updated",
    "Failed to update default environment",
  );
  const runtimeEnabled = useFeature("orchestratorK8sRuntime");
  const orchestratorNamespace = useFeature("orchestratorK8sNamespace");
  // Namespaces the platform has RBAC for (Helm rbac.environmentNamespaces).
  // These populate the namespace dropdown so an admin can't pick a namespace the
  // platform can't deploy to.
  const environmentNamespaces = useFeature("environmentNamespaces");

  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [description, setDescription] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Sync drafts whenever the dialog (re)opens for a target.
  useEffect(() => {
    if (open) {
      setShowConfirm(false);
      if (mode === "default") {
        setName(defaultEnvironment?.name ?? "");
        setNamespace(defaultEnvironment?.namespace ?? "");
        setDescription(defaultEnvironment?.description ?? "");
        setRestricted(defaultEnvironment?.restricted ?? false);
      } else {
        setName(environment?.name ?? "");
        setNamespace(environment?.namespace ?? "");
        setDescription(environment?.description ?? "");
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
  const canSave = mode === "edit" ? true : trimmedName.length > 0;

  // The current value is included so editing an environment whose namespace
  // predates the configured list never silently drops it.
  const namespaceOptions = Array.from(
    new Set(
      [...(environmentNamespaces ?? []), trimmedNamespace].filter(Boolean),
    ),
  );

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
            <Select
              value={
                trimmedNamespace === ""
                  ? NAMESPACE_DEFAULT_VALUE
                  : trimmedNamespace
              }
              onValueChange={(value) => {
                setNamespace(value === NAMESPACE_DEFAULT_VALUE ? "" : value);
                setShowConfirm(false);
              }}
              disabled={isPending}
            >
              <SelectTrigger id="environment-namespace" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NAMESPACE_DEFAULT_VALUE}>
                  {runtimeEnabled && orchestratorNamespace
                    ? `Use default (${orchestratorNamespace})`
                    : "Use default"}
                </SelectItem>
                {namespaceOptions.map((ns) => (
                  <SelectItem key={ns} value={ns}>
                    {ns}
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
