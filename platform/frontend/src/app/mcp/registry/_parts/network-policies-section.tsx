"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Textarea } from "@/components/ui/textarea";
import {
  type NetworkPolicyWithReferences,
  useCreateNetworkPolicy,
  useDeleteNetworkPolicy,
  useNetworkPolicies,
  useUpdateNetworkPolicy,
} from "@/lib/organization/network-policy.query";
import { useSetMcpRegistryAction } from "../layout";

type EgressMode = NetworkPolicyWithReferences["egressMode"];
type DomainPreset = NetworkPolicyWithReferences["domainPreset"];
type AllowedHttpMethods = NetworkPolicyWithReferences["allowedHttpMethods"];

export function NetworkPoliciesSection({ canEdit }: { canEdit: boolean }) {
  const setActionButton = useSetMcpRegistryAction();
  const { data: policies = [], isLoading } = useNetworkPolicies();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] =
    useState<NetworkPolicyWithReferences | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<NetworkPolicyWithReferences | null>(null);

  useEffect(() => {
    setActionButton(
      <Button
        className="h-9 shrink-0 px-3 text-sm"
        disabled={!canEdit}
        onClick={() => setCreateOpen(true)}
      >
        <Plus className="h-4 w-4" />
        Add Network Policy
      </Button>,
    );

    return () => setActionButton(null);
  }, [canEdit, setActionButton]);

  const columns: ColumnDef<NetworkPolicyWithReferences>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="flex flex-col font-medium">
            <span>{row.original.name}</span>
            {row.original.description && (
              <span className="max-w-80 truncate text-xs font-normal text-muted-foreground">
                {row.original.description}
              </span>
            )}
          </div>
        ),
      },
      {
        accessorKey: "egressMode",
        header: "Egress",
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.egressMode === "off" ? "secondary" : "outline"
            }
          >
            {formatEgressMode(row.original.egressMode)}
          </Badge>
        ),
      },
      {
        id: "domains",
        header: "Domains",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatDomainSummary(row.original)}
          </span>
        ),
      },
      {
        accessorKey: "allowedHttpMethods",
        header: "Methods",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatMethods(row.original.allowedHttpMethods)}
          </span>
        ),
      },
      {
        id: "assigned",
        header: "Assigned",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {totalReferences(row.original)}
          </span>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const policy = row.original;
          const references = totalReferences(policy);
          return (
            <TableRowActions
              actions={[
                {
                  icon: <Pencil className="h-4 w-4" />,
                  label: `Edit ${policy.name}`,
                  disabled: !canEdit,
                  onClick: () => setEditTarget(policy),
                },
                {
                  icon: <Trash2 className="h-4 w-4" />,
                  label: `Delete ${policy.name}`,
                  variant: "destructive",
                  disabled: !canEdit || references > 0,
                  disabledTooltip:
                    references > 0
                      ? "Clear all assignments before deleting this policy."
                      : undefined,
                  onClick: () => setDeleteTarget(policy),
                },
              ]}
            />
          );
        },
      },
    ],
    [canEdit],
  );

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        data={policies}
        getRowId={(policy) => policy.id}
        isLoading={isLoading}
        emptyMessage="No network policies"
      />

      <NetworkPolicyEditorDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        policy={null}
      />

      <NetworkPolicyEditorDialog
        open={editTarget !== null}
        onOpenChange={(v) => !v && setEditTarget(null)}
        policy={editTarget}
      />

      <DeleteNetworkPolicyDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function NetworkPolicyEditorDialog({
  open,
  onOpenChange,
  policy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policy: NetworkPolicyWithReferences | null;
}) {
  const create = useCreateNetworkPolicy();
  const update = useUpdateNetworkPolicy();
  const isPending = create.isPending || update.isPending;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [egressMode, setEgressMode] = useState<EgressMode>("restricted");
  const [domainPreset, setDomainPreset] = useState<DomainPreset>("none");
  const [allowedDomainsText, setAllowedDomainsText] = useState("");
  const [allowedHttpMethods, setAllowedHttpMethods] =
    useState<AllowedHttpMethods>("all");

  useEffect(() => {
    if (!open) return;
    setName(policy?.name ?? "");
    setDescription(policy?.description ?? "");
    setEgressMode(policy?.egressMode ?? "restricted");
    setDomainPreset(policy?.domainPreset ?? "none");
    setAllowedDomainsText((policy?.allowedDomains ?? []).join("\n"));
    setAllowedHttpMethods(policy?.allowedHttpMethods ?? "all");
  }, [open, policy]);

  const allowedDomains = useMemo(
    () =>
      allowedDomainsText
        .split(/\r?\n|,/)
        .map((domain) => domain.trim())
        .filter(Boolean),
    [allowedDomainsText],
  );

  const canSave = name.trim().length > 0 && !isPending;

  const save = async () => {
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      egressMode,
      domainPreset,
      allowedDomains,
      allowedHttpMethods,
    };

    const result = policy
      ? await update.mutateAsync({ id: policy.id, body })
      : await create.mutateAsync(body);

    if (result) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {policy ? "Edit network policy" : "Add network policy"}
          </DialogTitle>
          <DialogDescription>
            Configure reusable egress rules for environments and MCP server
            installations.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="network-policy-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="network-policy-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="e.g. Package managers"
              disabled={isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="network-policy-description">Description</Label>
            <Textarea
              id="network-policy-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              className="min-h-20"
              disabled={isPending}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Egress</Label>
              <Select
                value={egressMode}
                onValueChange={(value) => setEgressMode(value as EgressMode)}
                disabled={isPending}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="restricted">Restricted</SelectItem>
                  <SelectItem value="unrestricted">Unrestricted</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Domain preset</Label>
              <Select
                value={domainPreset}
                onValueChange={(value) =>
                  setDomainPreset(value as DomainPreset)
                }
                disabled={isPending || egressMode !== "restricted"}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="common_dependencies">
                    Common dependencies
                  </SelectItem>
                  <SelectItem value="package_managers">
                    Package managers
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="network-policy-domains">
              Additional allowed domains
            </Label>
            <Textarea
              id="network-policy-domains"
              value={allowedDomainsText}
              onChange={(e) => setAllowedDomainsText(e.target.value)}
              placeholder={"api.example.com\n*.example.org"}
              className="min-h-24 font-mono text-sm"
              disabled={isPending || egressMode !== "restricted"}
            />
          </div>

          <div className="flex items-start gap-3 rounded-md border p-3">
            <Checkbox
              id="network-policy-read-only-methods"
              checked={allowedHttpMethods === "read_only"}
              onCheckedChange={(checked) =>
                setAllowedHttpMethods(checked ? "read_only" : "all")
              }
              disabled={isPending || egressMode === "off"}
            />
            <span className="grid gap-1 text-sm">
              <Label
                htmlFor="network-policy-read-only-methods"
                className="font-medium"
              >
                Read-only HTTP methods
              </Label>
              <span className="text-muted-foreground">
                Restrict HTTP requests to GET, HEAD, and OPTIONS.
              </span>
            </span>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteNetworkPolicyDialog({
  target,
  onClose,
}: {
  target: NetworkPolicyWithReferences | null;
  onClose: () => void;
}) {
  const deletePolicy = useDeleteNetworkPolicy();
  return (
    <DeleteConfirmDialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
      onConfirm={async () => {
        if (!target) return;
        const result = await deletePolicy.mutateAsync(target.id);
        if (result) onClose();
      }}
      isPending={deletePolicy.isPending}
      title="Delete network policy?"
      description={
        target ? `${target.name} will be removed. This cannot be undone.` : ""
      }
    />
  );
}

function totalReferences(policy: NetworkPolicyWithReferences) {
  return (
    policy.references.environments +
    policy.references.defaultEnvironments +
    policy.references.catalogItems +
    policy.references.mcpServerInstallations
  );
}

function formatEgressMode(mode: EgressMode) {
  switch (mode) {
    case "off":
      return "Off";
    case "restricted":
      return "Restricted";
    case "unrestricted":
      return "Unrestricted";
  }
}

function formatDomainSummary(policy: NetworkPolicyWithReferences) {
  if (policy.egressMode === "off") return "None";
  if (policy.egressMode === "unrestricted") return "All domains";

  const preset =
    policy.domainPreset === "common_dependencies"
      ? "Common dependencies"
      : policy.domainPreset === "package_managers"
        ? "Package managers"
        : "No preset";
  const additional = policy.allowedDomains.length;
  return additional > 0 ? `${preset} + ${additional} custom` : preset;
}

function formatMethods(methods: AllowedHttpMethods) {
  return methods === "read_only" ? "GET, HEAD, OPTIONS" : "All";
}
