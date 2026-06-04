"use client";

import { DocsPage, getDocsUrl } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Info, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { FormDialog } from "@/components/form-dialog";
import { ReinstallConfirmBar } from "@/components/reinstall-confirm-bar";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  useCreateEnvironment,
  useDeleteEnvironment,
  useEnvironments,
  useK8sCapabilities,
  useUpdateEnvironment,
} from "@/lib/environment.query";
import {
  useDefaultEnvironment,
  useUpdateDefaultEnvironment,
} from "@/lib/organization.query";

const NETWORK_POLICY_DOCS_URL = getDocsUrl(
  DocsPage.PlatformPrivateRegistry,
  "network-policies",
);
const DOMAIN_PRESETS_DOCS_URL = getDocsUrl(
  DocsPage.PlatformPrivateRegistry,
  "domain-presets",
);

type NetworkPolicy = NonNullable<EnvironmentWithAssignedCount["networkPolicy"]>;
type EgressMode = NetworkPolicy["egressMode"];
type DomainPreset = NetworkPolicy["domainPreset"];

type EnvironmentTableRow =
  | {
      kind: "default";
      id: "default";
      name: string;
      namespace: string | null;
      description: string | null;
      networkPolicy: NetworkPolicy | null;
      restricted: boolean;
      assignedCatalogCount: number;
    }
  | (EnvironmentWithAssignedCount & { kind: "environment" });

export function EnvironmentsSection({
  canEdit,
  createOpen,
  onCreateOpenChange,
}: {
  canEdit: boolean;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const { data: environmentList, isLoading } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  const defaultAssignedCatalogCount =
    environmentList?.defaultAssignedCatalogCount ?? 0;
  const { data: capabilities } = useK8sCapabilities(canEdit);
  const defaultEnvironment = useDefaultEnvironment();
  const [editDefaultOpen, setEditDefaultOpen] = useState(false);
  const [editTarget, setEditTarget] =
    useState<EnvironmentWithAssignedCount | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<EnvironmentWithAssignedCount | null>(null);

  const rows: EnvironmentTableRow[] = useMemo(
    () => [
      {
        kind: "default",
        id: "default",
        name: defaultEnvironment.name,
        namespace: defaultEnvironment.namespace,
        description: defaultEnvironment.description,
        networkPolicy: defaultEnvironment.networkPolicy,
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
        accessorKey: "networkPolicy",
        header: "Network Egress",
        cell: ({ row }) => (
          <NetworkPolicyCell policy={row.original.networkPolicy} />
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
    [canEdit],
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
        onOpenChange={onCreateOpenChange}
        environment={null}
        capabilities={capabilities}
      />

      <EnvironmentEditorDialog
        mode="edit"
        open={editTarget !== null}
        onOpenChange={(v) => !v && setEditTarget(null)}
        environment={editTarget}
        capabilities={capabilities}
      />

      <EnvironmentEditorDialog
        mode="default"
        open={editDefaultOpen}
        onOpenChange={setEditDefaultOpen}
        environment={null}
        defaultEnvironment={defaultEnvironment}
        capabilities={capabilities}
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

function NetworkPolicyCell({ policy }: { policy: NetworkPolicy | null }) {
  if (!policy) {
    return <span className="text-muted-foreground">Built-in</span>;
  }

  return (
    <div className="flex flex-col">
      <span className="text-sm">{formatEgressMode(policy.egressMode)}</span>
      <span className="text-xs text-muted-foreground">
        {formatPolicySummary(policy)}
      </span>
    </div>
  );
}

// Sentinel for the "use default" namespace option (maps to a null namespace —
// the environment inherits the org default). shadcn Select can't use "".
const NAMESPACE_DEFAULT_VALUE = "__default_namespace__";

const EMPTY_NETWORK_POLICY: NetworkPolicy = {
  egressMode: "restricted",
  domainPreset: "none",
  allowedDomains: [],
  allowedCidrs: [],
};

function EnvironmentEditorDialog({
  mode,
  open,
  onOpenChange,
  environment,
  defaultEnvironment,
  capabilities,
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
    networkPolicy: NetworkPolicy | null;
    restricted: boolean;
  };
  capabilities: ReturnType<typeof useK8sCapabilities>["data"];
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
  const [egressMode, setEgressMode] = useState<EgressMode>("restricted");
  const [domainPreset, setDomainPreset] = useState<DomainPreset>("none");
  const [allowedDomainsText, setAllowedDomainsText] = useState("");
  const [allowedCidrsText, setAllowedCidrsText] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const syncNetworkPolicyDraft = useCallback((policy: NetworkPolicy | null) => {
    const nextPolicy = policy ?? EMPTY_NETWORK_POLICY;
    setEgressMode(nextPolicy.egressMode);
    setDomainPreset(nextPolicy.domainPreset);
    setAllowedDomainsText(nextPolicy.allowedDomains.join("\n"));
    setAllowedCidrsText(nextPolicy.allowedCidrs.join("\n"));
  }, []);

  // Sync drafts whenever the dialog (re)opens for a target.
  useEffect(() => {
    if (open) {
      setShowConfirm(false);
      if (mode === "default") {
        setName(defaultEnvironment?.name ?? "");
        setNamespace(defaultEnvironment?.namespace ?? "");
        setDescription(defaultEnvironment?.description ?? "");
        syncNetworkPolicyDraft(defaultEnvironment?.networkPolicy ?? null);
        setRestricted(defaultEnvironment?.restricted ?? false);
      } else {
        setName(environment?.name ?? "");
        setNamespace(environment?.namespace ?? "");
        setDescription(environment?.description ?? "");
        syncNetworkPolicyDraft(environment?.networkPolicy ?? null);
        setRestricted(environment?.restricted ?? false);
      }
    }
  }, [open, mode, environment, defaultEnvironment, syncNetworkPolicyDraft]);

  const isPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    updateDefaultMutation.isPending;
  const trimmedName = name.trim();
  const trimmedNamespace = namespace.trim();
  const trimmedDescription = description.trim();
  const canSave = trimmedName.length > 0;
  const supportsFqdn = capabilities?.networkPolicy.supportsFqdn === true;
  const networkPolicy = {
    egressMode,
    domainPreset:
      egressMode === "restricted" && supportsFqdn ? domainPreset : "none",
    allowedDomains:
      egressMode === "restricted" && supportsFqdn
        ? splitPolicyList(allowedDomainsText)
        : [],
    allowedCidrs:
      egressMode === "restricted" ? splitPolicyList(allowedCidrsText) : [],
  };

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
          networkPolicy,
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
          networkPolicy,
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
            networkPolicy,
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

  const title =
    mode === "create"
      ? "Add environment"
      : mode === "default"
        ? "Edit default environment"
        : "Edit environment";
  const dialogDescription =
    mode === "create"
      ? "Create an org-level deployment environment."
      : mode === "default"
        ? "Update the default environment."
        : "Update this environment.";

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={dialogDescription}
      size="medium"
      className="sm:max-w-3xl h-[88vh]"
    >
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
                environment:deploy-to-restricted
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
        <section className="space-y-4 border-t pt-4">
          <div className="space-y-1">
            <h3 className="font-medium text-sm">Network Egress Policy</h3>
            <p className="text-xs text-muted-foreground">
              Configure outbound network access for MCP workloads in this
              environment.{" "}
              <ExternalDocsLink href={NETWORK_POLICY_DOCS_URL}>
                View docs
              </ExternalDocsLink>
            </p>
          </div>

          <NetworkPolicyFields
            egressMode={egressMode}
            setEgressMode={setEgressMode}
            domainPreset={domainPreset}
            setDomainPreset={setDomainPreset}
            allowedDomainsText={allowedDomainsText}
            setAllowedDomainsText={setAllowedDomainsText}
            allowedCidrsText={allowedCidrsText}
            setAllowedCidrsText={setAllowedCidrsText}
            supportsFqdn={supportsFqdn}
            provider={capabilities?.networkPolicy.provider ?? null}
            disabled={isPending}
          />
        </section>
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
        <DialogStickyFooter>
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
        </DialogStickyFooter>
      )}
    </FormDialog>
  );
}

function NetworkPolicyFields({
  egressMode,
  setEgressMode,
  domainPreset,
  setDomainPreset,
  allowedDomainsText,
  setAllowedDomainsText,
  allowedCidrsText,
  setAllowedCidrsText,
  supportsFqdn,
  provider,
  disabled,
}: {
  egressMode: EgressMode;
  setEgressMode: (value: EgressMode) => void;
  domainPreset: DomainPreset;
  setDomainPreset: (value: DomainPreset) => void;
  allowedDomainsText: string;
  setAllowedDomainsText: (value: string) => void;
  allowedCidrsText: string;
  setAllowedCidrsText: (value: string) => void;
  supportsFqdn: boolean;
  provider: string | null;
  disabled: boolean;
}) {
  return (
    <div className="space-y-4">
      {provider === "none" ? (
        <Alert variant="info">
          <Info className="h-4 w-4" />
          <AlertTitle>Network policy enforcement unavailable</AlertTitle>
          <AlertDescription className="block leading-6">
            Kubernetes access is not configured, or network policy capabilities
            could not be inspected. Enable a Kubernetes network policy provider
            before relying on these policies.
          </AlertDescription>
        </Alert>
      ) : !supportsFqdn ? (
        <Alert variant="info">
          <Info className="h-4 w-4" />
          <AlertTitle>Domain allowlists unavailable</AlertTitle>
          <AlertDescription className="block leading-6">
            Standard Kubernetes{" "}
            <code className="inline rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
              NetworkPolicy
            </code>{" "}
            supports IP/CIDR rules only. Domain allowlists require a supported
            FQDN policy provider.{" "}
            <ExternalDocsLink href={NETWORK_POLICY_DOCS_URL}>
              View docs
            </ExternalDocsLink>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <FieldLabel
          label="Egress"
          description="Controls outbound internet access. Off blocks egress, Restricted allows only the CIDR/domain rules below, and Unrestricted allows all egress."
        />
        <Select
          value={egressMode}
          onValueChange={(value) => setEgressMode(value as EgressMode)}
          disabled={disabled}
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
        <FieldLabel
          label="Domain preset"
          description={
            <>
              Adds a maintained domain allowlist for common dependency or
              package manager traffic. Requires a supported FQDN policy
              provider.{" "}
              <ExternalDocsLink href={DOMAIN_PRESETS_DOCS_URL}>
                View presets
              </ExternalDocsLink>
            </>
          }
        />
        <Select
          value={domainPreset}
          onValueChange={(value) => setDomainPreset(value as DomainPreset)}
          disabled={disabled || egressMode !== "restricted" || !supportsFqdn}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="common_dependencies">
              Common dependencies
            </SelectItem>
            <SelectItem value="package_managers">Package managers</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <FieldLabel
          htmlFor="network-policy-cidrs"
          label="Allowed CIDRs"
          description="IPv4 or IPv6 CIDR ranges that restricted workloads may reach. These rules are enforced by standard Kubernetes NetworkPolicy."
        />
        <Textarea
          id="network-policy-cidrs"
          value={allowedCidrsText}
          onChange={(e) => setAllowedCidrsText(e.target.value)}
          placeholder={"203.0.113.0/24\n2001:db8::/32"}
          className="min-h-20 font-mono text-sm"
          disabled={disabled || egressMode !== "restricted"}
        />
      </div>

      <div className="space-y-2">
        <FieldLabel
          htmlFor="network-policy-domains"
          label="Allowed domains"
          description="Domain names or wildcard domains that restricted workloads may reach. Requires a supported FQDN policy provider."
        />
        <Textarea
          id="network-policy-domains"
          value={allowedDomainsText}
          onChange={(e) => setAllowedDomainsText(e.target.value)}
          placeholder={"api.example.com\n*.registry.example.com"}
          className="min-h-20 font-mono text-sm"
          disabled={disabled || egressMode !== "restricted" || !supportsFqdn}
        />
      </div>
    </div>
  );
}

function FieldLabel({
  htmlFor,
  label,
  description,
}: {
  htmlFor?: string;
  label: string;
  description: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            aria-label={`${label} help`}
          >
            <Info className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 text-sm">
          {description}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function splitPolicyList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
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

function formatPolicySummary(policy: NetworkPolicy) {
  if (policy.egressMode === "off") return "No outbound egress";
  if (policy.egressMode === "unrestricted") return "All outbound egress";

  const parts: string[] = [];
  if (policy.domainPreset !== "none") {
    parts.push(
      policy.domainPreset === "common_dependencies"
        ? "Common dependencies"
        : "Package managers",
    );
  }
  if (policy.allowedDomains.length > 0) {
    parts.push(`${policy.allowedDomains.length} domain rules`);
  }
  if (policy.allowedCidrs.length > 0) {
    parts.push(`${policy.allowedCidrs.length} CIDR rules`);
  }
  return parts.length > 0 ? parts.join(", ") : "No egress rules";
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
