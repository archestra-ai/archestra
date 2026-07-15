"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Info, Pencil, Plus, Trash2, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  useOrganization,
  useUpdateDefaultEnvironment,
} from "@/lib/organization.query";
import {
  clearEnvironmentDialogParams,
  ENVIRONMENT_CREATE_PARAM,
  ENVIRONMENT_DEFAULT_VALUE,
  ENVIRONMENT_EDIT_PARAM,
  setEnvironmentEditParam,
} from "./environment-edit-link";
import {
  buildEditorNetworkPolicy,
  resolveEditorDraftPolicy,
  resolveNetworkPolicyUpdate,
} from "./environment-policy-draft";
import { compileValidationRegex } from "./environment-validation-helpers";

const NETWORK_POLICY_DOCS_URL = getDocsUrl(
  DocsPage.PlatformPrivateRegistry,
  "network-egress-policies",
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

export function EnvironmentsSection({ canEdit }: { canEdit: boolean }) {
  const { data: environmentList, isLoading } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  const defaultAssignedCatalogCount =
    environmentList?.defaultAssignedCatalogCount ?? 0;
  const { data: capabilities } = useK8sCapabilities(canEdit);
  const defaultEnvironment = useDefaultEnvironment();
  const [deleteTarget, setDeleteTarget] =
    useState<EnvironmentWithAssignedCount | null>(null);

  // Which editor is open is derived from the URL (`?edit=<id|default>` /
  // `?create`) so the form survives a reload and is shareable. Only admins
  // (canEdit) open one.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchString = searchParams.toString();
  const editId = searchParams.get(ENVIRONMENT_EDIT_PARAM);
  // An `edit` param wins over `create`, so a hand-crafted `?edit=…&create=1`
  // opens a single editor rather than two stacked dialogs.
  const createOpen =
    canEdit && !editId && searchParams.has(ENVIRONMENT_CREATE_PARAM);
  const editEnvironment = useMemo(
    () =>
      editId && editId !== ENVIRONMENT_DEFAULT_VALUE
        ? (environments.find((environment) => environment.id === editId) ??
          null)
        : null,
    [editId, environments],
  );
  const editDefaultOpen = canEdit && editId === ENVIRONMENT_DEFAULT_VALUE;
  const editTargetOpen = canEdit && editEnvironment !== null;

  const writeSearch = useCallback(
    (search: string) => {
      router.replace(search ? `${pathname}?${search}` : pathname, {
        scroll: false,
      });
    },
    [router, pathname],
  );
  const openEditor = useCallback(
    (id: string) => writeSearch(setEnvironmentEditParam(searchString, id)),
    [writeSearch, searchString],
  );
  const closeEditor = useCallback(
    () => writeSearch(clearEnvironmentDialogParams(searchString)),
    [writeSearch, searchString],
  );

  // A deep link to an `edit` id that isn't a real environment (deleted, typo)
  // is cleared so it doesn't leave a stuck-open URL. Only act on a loaded,
  // non-empty list: `useEnvironments` returns an empty list on a fetch error
  // (not an error state), and clearing then would erase a valid deep link that
  // a retry could still resolve.
  useEffect(() => {
    if (
      environments.length > 0 &&
      editId &&
      editId !== ENVIRONMENT_DEFAULT_VALUE &&
      !editEnvironment
    ) {
      closeEditor();
    }
  }, [environments.length, editId, editEnvironment, closeEditor]);

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
                  // item.id is the `"default"` sentinel for the default row.
                  onClick: () => openEditor(item.id),
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
    [canEdit, openEditor],
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
        onOpenChange={(open) => !open && closeEditor()}
        environment={null}
        capabilities={capabilities}
      />

      <EnvironmentEditorDialog
        mode="edit"
        open={editTargetOpen}
        onOpenChange={(open) => !open && closeEditor()}
        environment={editEnvironment}
        defaultEnvironment={defaultEnvironment}
        capabilities={capabilities}
      />

      <EnvironmentEditorDialog
        mode="default"
        open={editDefaultOpen}
        onOpenChange={(open) => !open && closeEditor()}
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
    validationRegex: string | null;
    trustedImageRegistries: string[] | null;
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
  // Whether the user changed any egress control since the dialog opened. Only a
  // touched policy is persisted — see resolveNetworkPolicyUpdate — so seeding the
  // controls for display never lets a passive save rewrite the stored policy.
  const [egressDirty, setEgressDirty] = useState(false);
  const [restricted, setRestricted] = useState(false);
  const [validationRegex, setValidationRegex] = useState("");
  const [trustedImageRegistries, setTrustedImageRegistries] = useState<
    string[]
  >([]);
  const [registryDraft, setRegistryDraft] = useState("");
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const syncNetworkPolicyDraft = useCallback((policy: NetworkPolicy) => {
    setEgressMode(policy.egressMode);
    setDomainPreset(policy.domainPreset);
    setAllowedDomainsText(policy.allowedDomains.join("\n"));
    setAllowedCidrsText(policy.allowedCidrs.join("\n"));
  }, []);

  // Whether the org query has resolved — so a null org default policy can be
  // trusted as genuinely absent (→ unrestricted floor) rather than still-loading.
  const { isSuccess: orgLoaded } = useOrganization();

  // Sync drafts whenever the dialog (re)opens for a target.
  useEffect(() => {
    if (open) {
      setShowConfirm(false);
      setRegistryDraft("");
      setRegistryError(null);
      setEgressDirty(false);
      // The org default a null-policy env falls through to. Only trustworthy once
      // the org query has resolved (orgLoaded), so the seed gates on it.
      const orgDefaultPolicy = defaultEnvironment?.networkPolicy ?? null;
      if (mode === "default") {
        setName(defaultEnvironment?.name ?? "");
        setNamespace(defaultEnvironment?.namespace ?? "");
        setDescription(defaultEnvironment?.description ?? "");
        syncNetworkPolicyDraft(
          resolveEditorDraftPolicy({
            mode: "default",
            policy: orgDefaultPolicy,
            orgDefaultPolicy,
            policyLoaded: orgLoaded,
          }),
        );
        setRestricted(defaultEnvironment?.restricted ?? false);
        setValidationRegex(defaultEnvironment?.validationRegex ?? "");
        setTrustedImageRegistries(
          defaultEnvironment?.trustedImageRegistries ?? [],
        );
      } else {
        setName(environment?.name ?? "");
        setNamespace(environment?.namespace ?? "");
        setDescription(environment?.description ?? "");
        syncNetworkPolicyDraft(
          resolveEditorDraftPolicy({
            mode,
            policy: environment?.networkPolicy ?? null,
            orgDefaultPolicy,
            policyLoaded: orgLoaded,
          }),
        );
        setRestricted(environment?.restricted ?? false);
        setValidationRegex(environment?.validationRegex ?? "");
        setTrustedImageRegistries(environment?.trustedImageRegistries ?? []);
      }
    }
  }, [
    open,
    mode,
    environment,
    defaultEnvironment,
    orgLoaded,
    syncNetworkPolicyDraft,
  ]);

  const isPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    updateDefaultMutation.isPending;
  const trimmedName = name.trim();
  const trimmedNamespace = namespace.trim();
  const trimmedDescription = description.trim();
  const validationRegexValue =
    validationRegex.trim() === "" ? null : validationRegex;
  const trustedImageRegistriesValue =
    trustedImageRegistries.length > 0 ? trustedImageRegistries : null;

  const addTrustedRegistry = () => {
    const value = registryDraft.trim();
    if (!value) return;
    // Mirror the backend TrustedImageRegistryEntrySchema so an invalid entry is
    // rejected here instead of failing the whole save.
    if (!/^[a-z0-9._:/-]+$/i.test(value) || value.length > 255) {
      setRegistryError(
        "Use only letters, numbers and . _ : / - (e.g. ghcr.io/acme).",
      );
      return;
    }
    if (!trustedImageRegistries.includes(value)) {
      setTrustedImageRegistries([...trustedImageRegistries, value]);
    }
    setRegistryDraft("");
    setRegistryError(null);
  };

  const removeTrustedRegistry = (value: string) => {
    setTrustedImageRegistries(
      trustedImageRegistries.filter((r) => r !== value),
    );
  };
  const validationRegexError =
    validationRegexValue !== null &&
    compileValidationRegex(validationRegexValue) === null
      ? "Not a valid regular expression"
      : null;
  const canSave = trimmedName.length > 0 && validationRegexError === null;
  const supportsFqdn = capabilities?.networkPolicy.supportsFqdn === true;
  const enforcementUnavailable =
    capabilities?.networkPolicy.provider === "none";
  const originalNetworkPolicy =
    mode === "default"
      ? (defaultEnvironment?.networkPolicy ?? null)
      : (environment?.networkPolicy ?? null);
  // A null-policy target is seeded from the org default, so its egress can't be
  // edited until that query resolves — otherwise a change would be seeded off the
  // locked-down fallback and dropped on save (see resolveNetworkPolicyUpdate),
  // acknowledged as saved but never applied. An explicit policy is its own
  // baseline and stays editable regardless. Create needs no baseline.
  const egressBaselineLoaded =
    mode === "create" || originalNetworkPolicy !== null || orgLoaded;
  const networkPolicy = buildEditorNetworkPolicy({
    enforcementUnavailable,
    egressMode,
    domainPreset,
    allowedDomainsText,
    allowedCidrsText,
    originalPolicy: originalNetworkPolicy,
  });

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
    const policyPatch = resolveNetworkPolicyUpdate({
      mode,
      egressDirty,
      originalPolicy: originalNetworkPolicy,
      orgLoaded,
      networkPolicy,
    });
    if (mode === "create") {
      createMutation.mutate(
        {
          name: trimmedName,
          namespace: namespaceValue,
          description: descriptionValue,
          ...policyPatch,
          restricted,
          validationRegex: validationRegexValue,
          trustedImageRegistries: trustedImageRegistriesValue,
        },
        { onSuccess: (created) => created && onOpenChange(false) },
      );
    } else if (mode === "default") {
      updateDefaultMutation.mutate(
        {
          name: trimmedName,
          namespace: namespaceValue,
          description: descriptionValue,
          ...policyPatch,
          restricted,
          validationRegex: validationRegexValue,
          trustedImageRegistries: trustedImageRegistriesValue,
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
            ...policyPatch,
            restricted,
            validationRegex: validationRegexValue,
            trustedImageRegistries: trustedImageRegistriesValue,
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
        <div className="space-y-2">
          <Label htmlFor="environment-validation-regex">Validation rule</Label>
          <p className="text-xs text-muted-foreground">
            Allowlist regular expression: config values entered when installing
            into this environment are accepted only if they match. Leave empty
            to disable. To block a substring (e.g. <code>prod</code>), use a
            negative lookahead like{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              ^(?!.*(prod|production)).*$
            </code>
            .
          </p>
          <Input
            id="environment-validation-regex"
            value={validationRegex}
            onChange={(e) => setValidationRegex(e.target.value)}
            placeholder="^(?!.*(prod|production)).*$"
            className="font-mono"
            disabled={isPending}
            aria-invalid={validationRegexError ? true : undefined}
          />
          {validationRegexError && (
            <p className="text-xs text-destructive">{validationRegexError}</p>
          )}
        </div>
        {runtimeEnabled && (
          <div className="space-y-2">
            <Label htmlFor="environment-trusted-registries">
              Trusted image registries
            </Label>
            <p className="text-xs text-muted-foreground">
              List of trusted Docker image registries. Any MCP server whose
              image isn't on this list is held for admin approval before it can
              be installed. Leave empty to allow any image.
            </p>
            <div className="flex gap-2">
              <Input
                id="environment-trusted-registries"
                value={registryDraft}
                onChange={(e) => {
                  setRegistryDraft(e.target.value);
                  setRegistryError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTrustedRegistry();
                  }
                }}
                placeholder="ghcr.io/acme"
                className="font-mono"
                disabled={isPending}
              />
              <Button
                type="button"
                variant="outline"
                onClick={addTrustedRegistry}
                disabled={isPending || registryDraft.trim() === ""}
              >
                <Plus className="h-4 w-4" />
                Add
              </Button>
            </div>
            {registryError && (
              <p className="text-xs text-destructive">{registryError}</p>
            )}
            {trustedImageRegistries.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {trustedImageRegistries.map((registry) => (
                  <Badge
                    key={registry}
                    variant="secondary"
                    className="gap-1 font-mono"
                  >
                    {registry}
                    <button
                      type="button"
                      onClick={() => removeTrustedRegistry(registry)}
                      disabled={isPending}
                      aria-label={`Remove ${registry}`}
                      className="rounded-full text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
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
            setEgressMode={(value) => {
              setEgressMode(value);
              setEgressDirty(true);
            }}
            domainPreset={domainPreset}
            setDomainPreset={(value) => {
              setDomainPreset(value);
              setEgressDirty(true);
            }}
            allowedDomainsText={allowedDomainsText}
            setAllowedDomainsText={(value) => {
              setAllowedDomainsText(value);
              setEgressDirty(true);
            }}
            allowedCidrsText={allowedCidrsText}
            setAllowedCidrsText={(value) => {
              setAllowedCidrsText(value);
              setEgressDirty(true);
            }}
            supportsFqdn={supportsFqdn}
            provider={capabilities?.networkPolicy.provider ?? null}
            baselineLoaded={egressBaselineLoaded}
            disabled={isPending || !egressBaselineLoaded}
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
  baselineLoaded,
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
  baselineLoaded: boolean;
  disabled: boolean;
}) {
  // No enforcer on the cluster: every rule below would be accepted but never
  // enforced, so the whole egress section is disabled rather than offering
  // controls that silently do nothing.
  const enforcementUnavailable = provider === "none";
  return (
    <div className="space-y-4">
      {enforcementUnavailable ? (
        <Alert variant="info">
          <Info className="h-4 w-4" />
          <AlertTitle>Network policy enforcement unavailable</AlertTitle>
          <AlertDescription className="block leading-6">
            No Kubernetes NetworkPolicy enforcer (Calico, Cilium, or a supported
            FQDN provider) was detected, or Kubernetes access isn't configured,
            so egress can't be enforced on this cluster. These controls are
            disabled until a supported network policy provider is available.{" "}
            <ExternalDocsLink href={NETWORK_POLICY_DOCS_URL}>
              View docs
            </ExternalDocsLink>
          </AlertDescription>
        </Alert>
      ) : !baselineLoaded ? (
        <Alert variant="info">
          <Info className="h-4 w-4" />
          <AlertTitle>Organization default not loaded</AlertTitle>
          <AlertDescription className="block leading-6">
            This environment inherits its egress from the organization default,
            which hasn't loaded. Editing is disabled until it's available, so a
            change isn't saved against the wrong baseline.
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
          disabled={disabled || enforcementUnavailable}
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
          disabled={
            disabled || enforcementUnavailable || egressMode !== "restricted"
          }
        />
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
