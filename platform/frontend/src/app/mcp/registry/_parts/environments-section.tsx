"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Info, Pencil, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { FormDialog } from "@/components/form-dialog";
import { ReinstallConfirmBar } from "@/components/reinstall-confirm-bar";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
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
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useFeature } from "@/lib/config/config.query";
import {
  type EnvironmentWithAssignedCount,
  useBulkDeleteEnvironments,
  useCreateEnvironment,
  useDeleteEnvironment,
  useEnvironments,
  useK8sCapabilities,
  useUpdateEnvironment,
} from "@/lib/environment.query";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import {
  useDefaultEnvironment,
  useOrganization,
  useUpdateDefaultEnvironment,
} from "@/lib/organization.query";
import {
  clearEnvironmentDialogParams,
  ENVIRONMENT_CREATE_PARAM,
  ENVIRONMENT_DEFAULT_VALUE,
  ENVIRONMENT_DEFAULTS_PARAM,
  ENVIRONMENT_EDIT_PARAM,
  setEnvironmentEditParam,
} from "./environment-edit-link";
import {
  buildEditorNetworkPolicy,
  resolveEditorDraftPolicy,
  resolveNetworkPolicyUpdate,
} from "./environment-policy-draft";
import { EnvironmentResourceDefaultsDialog } from "./environment-resource-defaults-dialog";
import { compileValidationRegex } from "./environment-validation-helpers";

const ENVIRONMENTS_DOCS_URL = getDocsUrl(DocsPage.PlatformEnvironments);
const NETWORK_POLICY_DOCS_URL = getDocsUrl(
  DocsPage.PlatformEnvironments,
  "network-egress-policies",
);
const PUBLIC_INTERNET_FLOOR_DOCS_URL = getDocsUrl(
  DocsPage.PlatformEnvironments,
  "the-public-internet-floor",
);
const DOMAIN_PRESETS_DOCS_URL = getDocsUrl(
  DocsPage.PlatformEnvironments,
  "domain-presets",
);

type NetworkPolicy = NonNullable<EnvironmentWithAssignedCount["networkPolicy"]>;
type EgressMode = NetworkPolicy["egressMode"];
type EgressModeFilter = EgressMode | "all";
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
  const { data: environmentList, isFetching: isLoading } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  const defaultAssignedCatalogCount =
    environmentList?.defaultAssignedCatalogCount ?? 0;
  const { data: capabilities } = useK8sCapabilities(canEdit);
  const defaultEnvironment = useDefaultEnvironment();
  const [deleteTarget, setDeleteTarget] =
    useState<EnvironmentWithAssignedCount | null>(null);
  const [search, setSearch] = useState("");
  const [egressModeFilter, setEgressModeFilter] =
    useState<EgressModeFilter>("all");

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
  // Same gate as the cog that opens it: with no environments to choose from,
  // every kind can only land in Default, so a hand-crafted link opens nothing.
  const resourceDefaultsOpen =
    canEdit &&
    !editId &&
    environments.length > 0 &&
    searchParams.has(ENVIRONMENT_DEFAULTS_PARAM);

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
  const normalizedSearch = search.trim().toLowerCase();
  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const matchesSearch =
          normalizedSearch === "" ||
          row.name.toLowerCase().includes(normalizedSearch) ||
          row.namespace?.toLowerCase().includes(normalizedSearch);
        const effectiveEgressMode =
          row.networkPolicy?.egressMode ??
          defaultEnvironment.networkPolicy?.egressMode ??
          "unrestricted";
        const matchesEgressMode =
          egressModeFilter === "all" ||
          effectiveEgressMode === egressModeFilter;

        return matchesSearch && matchesEgressMode;
      }),
    [
      defaultEnvironment.networkPolicy?.egressMode,
      egressModeFilter,
      normalizedSearch,
      rows,
    ],
  );
  const hasActiveFilters =
    normalizedSearch !== "" || egressModeFilter !== "all";

  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const bulkDelete = useBulkDeleteEnvironments();

  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected: selectedEnvironments,
    selectAllMatching,
  } = useBulkSelection({
    rows: filteredRows,
    getId: (row) => row.id,
    // The Default row is synthetic — it stands for "no environment" — and the
    // delete route refuses one that still has catalog items assigned.
    canSelect: (row) =>
      row.kind === "environment" && row.assignedCatalogCount === 0,
    filterSignature: `environments:${normalizedSearch}:${egressModeFilter}`,
    matchDescription: "can be deleted",
  });

  const columns: ColumnDef<EnvironmentTableRow>[] = useMemo(
    () => [
      createSelectColumn<EnvironmentTableRow>({
        rowLabel: (row) => `Select ${row.name}`,
        allLabel: "Select all environments on this page",
        // Matches what the row's own Delete allows: the Default row is
        // synthetic, and the backend refuses (409) an environment that still
        // has catalog items assigned. Offering those would build a selection
        // guaranteed to come back as failures.
        canSelect: (row) =>
          row.kind === "environment" && row.assignedCatalogCount === 0,
        disabledReason: (row) =>
          row.kind === "default"
            ? "The default environment cannot be deleted"
            : "Remove assigned MCP servers before deleting",
      }),
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
    <BulkActionsScope className="space-y-4">
      <CollectionFilters>
        <FilterBar
          leading
          onClearFilters={
            hasActiveFilters
              ? () => {
                  setSearch("");
                  setEgressModeFilter("all");
                }
              : undefined
          }
        >
          <SearchInput
            placeholder="Search by name or namespace"
            value={search}
            onSearchChange={setSearch}
            syncQueryParams={false}
            className={filterSearchClass}
          />
          <FilterSelect
            value={egressModeFilter}
            onValueChange={(value) =>
              setEgressModeFilter(value as EgressModeFilter)
            }
            placeholder="Filter by network egress"
            items={[
              { value: "all", label: "All network egress" },
              { value: "unrestricted", label: "Public internet" },
              { value: "restricted", label: "Allowlist" },
              { value: "off", label: "Block all" },
            ]}
            inactiveValue="all"
          />
        </FilterBar>
      </CollectionFilters>

      <BulkActions
        count={selectedEnvironments.length}
        noun="environment"
        onClear={clearSelection}
        selectAllMatching={selectAllMatching}
        busy={bulkDelete.isPending}
      >
        <PermissionButton
          permissions={{ environment: ["delete"] }}
          variant="destructive"
          size="sm"
          onClick={() => setBulkDeleteOpen(true)}
        >
          <Trash2 className="h-4 w-4" />
          <span>Delete</span>
        </PermissionButton>
      </BulkActions>

      <DataTable
        columns={columns}
        data={filteredRows}
        getRowId={(row) => row.id}
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        onPageRowIdsChange={onPageRowIdsChange}
        hideSelectedCount
        isLoading={isLoading}
        emptyMessage="No environments"
        hasActiveFilters={hasActiveFilters}
        filteredEmptyMessage="No environments match your filters"
        onClearFilters={() => {
          setSearch("");
          setEgressModeFilter("all");
        }}
      />

      {bulkDeleteOpen && (
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="Delete environments"
          description={`Delete ${selectedEnvironments.length} ${
            selectedEnvironments.length === 1 ? "environment" : "environments"
          }? Resources in them fall back to Default.`}
          isPending={bulkDelete.isPending}
          onConfirm={() => {
            bulkDelete.mutate(selectedEnvironments, {
              onSuccess: (outcome) => {
                reportBulkOutcome({
                  outcome,
                  verb: "Deleted",
                  failureVerb: "delete",
                  noun: "environment",
                });
                setBulkDeleteOpen(false);
                if (outcome.failed.length === 0) clearSelection();
              },
            });
          }}
          confirmLabel="Delete environments"
          pendingLabel="Deleting..."
        />
      )}

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

      <EnvironmentResourceDefaultsDialog
        open={resourceDefaultsOpen}
        onOpenChange={(open) => !open && closeEditor()}
        canEdit={canEdit}
      />
    </BulkActionsScope>
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
  // Only a measured "nothing enforces" freezes the policy. A cluster we merely
  // failed to measure keeps its editor: locking it there breaks every cluster
  // that enforces without advertising a CRD.
  const enforcementUnavailable =
    capabilities?.networkPolicy.enforcementStatus === "verified-not-enforced";
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
  const dialogDescription = (
    <>
      <span>
        {mode === "create"
          ? "Create an org-level deployment environment."
          : mode === "default"
            ? "Update the default environment."
            : "Update this environment."}
      </span>{" "}
      <ExternalDocsLink
        href={ENVIRONMENTS_DOCS_URL}
        className="underline"
        showIcon={false}
      >
        Learn more
      </ExternalDocsLink>
    </>
  );

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
              Deploying to this environment requires the{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                deploy-to-restricted
              </code>{" "}
              permission on the resource being deployed (e.g.{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                mcpRegistry
              </code>{" "}
              for MCP servers,{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                agent
              </code>{" "}
              for agents).
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
              Configure outbound network access for workloads in this
              environment.
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
            enforcementStatus={
              capabilities?.networkPolicy.enforcementStatus ?? null
            }
            baselineLoaded={egressBaselineLoaded}
            disabled={isPending || !egressBaselineLoaded}
          />
        </section>
        <Accordion type="single" collapsible className="border-t">
          <AccordionItem value="advanced">
            <AccordionTrigger className="hover:no-underline">
              Advanced
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pb-4">
              <div className="space-y-2">
                <Label htmlFor="environment-validation-regex">
                  Validation rule
                </Label>
                <p className="text-xs text-muted-foreground">
                  Allowlist regular expression: config values entered when
                  installing into this environment are accepted only if they
                  match. Leave empty to disable. To block a substring (e.g.{" "}
                  <code>prod</code>), use a negative lookahead like{" "}
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
                  <p className="text-xs text-destructive">
                    {validationRegexError}
                  </p>
                )}
              </div>
              {runtimeEnabled && (
                <div className="space-y-2">
                  <Label htmlFor="environment-trusted-registries">
                    Trusted image registries
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    List of trusted Docker image registries. Any MCP server
                    whose image isn't on this list is held for admin approval
                    before it can be installed. Leave empty to allow any image.
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
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </DialogBody>
      {showConfirm ? (
        <ReinstallConfirmBar
          mode="auto"
          className="mt-0"
          affectedServerCount={environment?.assignedCatalogCount ?? 0}
          isSubmitting={isPending}
          onCancel={() => setShowConfirm(false)}
          onConfirm={doSave}
        />
      ) : (
        <DialogStickyFooter className="mt-0">
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

export function NetworkPolicyFields({
  egressMode,
  setEgressMode,
  domainPreset,
  setDomainPreset,
  allowedDomainsText,
  setAllowedDomainsText,
  allowedCidrsText,
  setAllowedCidrsText,
  supportsFqdn,
  enforcementStatus,
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
  enforcementStatus:
    | "verified-enforced"
    | "verified-not-enforced"
    | "unknown"
    | null;
  baselineLoaded: boolean;
  disabled: boolean;
}) {
  // A probe watched a deny-all policy fail to stop a packet: every rule below
  // would be accepted and never enforced, so the section is disabled rather
  // than offering controls that silently do nothing.
  const enforcementUnavailable = enforcementStatus === "verified-not-enforced";
  // Nothing measured this cluster — the probe was disabled, never ran, or its
  // pods aged out. The controls stay usable because most such clusters do
  // enforce; the notice is what stops "no warning" from reading as "verified".
  const enforcementUnverified =
    enforcementStatus === "unknown" || enforcementStatus === null;
  return (
    <div className="space-y-4">
      {enforcementUnavailable ? (
        <Alert variant="warning">
          <TriangleAlert className="h-4 w-4" />
          <AlertTitle>Network policy enforcement test failed</AlertTitle>
          <AlertDescription className="block leading-6">
            Egress rules would be accepted and then ignored, so these controls
            stay disabled until the cluster enforces NetworkPolicy.{" "}
            <ExternalDocsLink
              href={NETWORK_POLICY_DOCS_URL}
              className="underline"
              showIcon={false}
            >
              View docs
            </ExternalDocsLink>
          </AlertDescription>
        </Alert>
      ) : enforcementUnverified ? (
        <Alert variant="info">
          <Info className="h-4 w-4" />
          <AlertTitle>Network policy enforcement not verified</AlertTitle>
          <AlertDescription className="block leading-6">
            Nothing has confirmed this cluster acts on NetworkPolicy, so the
            rules below may be accepted and then ignored. They are still
            applied, and the enforcement check runs on the next upgrade.{" "}
            <ExternalDocsLink
              href={NETWORK_POLICY_DOCS_URL}
              className="underline"
              showIcon={false}
            >
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
            <ExternalDocsLink
              href={NETWORK_POLICY_DOCS_URL}
              className="underline"
              showIcon={false}
            >
              View docs
            </ExternalDocsLink>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor="network-policy-egress">Egress</Label>
          <p className="text-xs text-muted-foreground">
            Choose whether workloads can reach nothing, only approved
            destinations, or the public internet. Public internet keeps private
            and reserved ranges blocked.{" "}
            <ExternalDocsLink
              href={PUBLIC_INTERNET_FLOOR_DOCS_URL}
              className="underline"
              showIcon={false}
            >
              View blocked ranges
            </ExternalDocsLink>
          </p>
        </div>
        <Select
          value={egressMode}
          onValueChange={(value) => setEgressMode(value as EgressMode)}
          disabled={disabled || enforcementUnavailable}
        >
          <SelectTrigger id="network-policy-egress" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off" description={EGRESS_MODE_DESCRIPTIONS.off}>
              {EGRESS_MODE_LABELS.off}
            </SelectItem>
            <SelectItem
              value="restricted"
              description={EGRESS_MODE_DESCRIPTIONS.restricted}
            >
              {EGRESS_MODE_LABELS.restricted}
            </SelectItem>
            <SelectItem
              value="unrestricted"
              description={EGRESS_MODE_DESCRIPTIONS.unrestricted}
            >
              {EGRESS_MODE_LABELS.unrestricted}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <FieldLabel
          htmlFor="network-policy-cidrs"
          label={
            egressMode === "unrestricted"
              ? "Additional allowed CIDRs"
              : "Allowed CIDRs"
          }
          description={
            egressMode === "unrestricted" ? (
              <>
                Optional IPv4 or IPv6 CIDR ranges to allow in addition to public
                internet. Other private and reserved ranges remain blocked.{" "}
                <ExternalDocsLink
                  href={PUBLIC_INTERNET_FLOOR_DOCS_URL}
                  className="underline"
                  showIcon={false}
                >
                  View blocked ranges
                </ExternalDocsLink>
              </>
            ) : egressMode === "off" ? (
              "CIDR exceptions are unavailable while all egress is blocked."
            ) : (
              "IPv4 or IPv6 CIDR ranges that workloads in Allowlist mode may reach."
            )
          }
        />
        <Textarea
          id="network-policy-cidrs"
          value={allowedCidrsText}
          onChange={(e) => setAllowedCidrsText(e.target.value)}
          placeholder={"10.20.0.0/16\nfd00:1234::/64"}
          className="min-h-20 font-mono text-sm"
          disabled={disabled || enforcementUnavailable || egressMode === "off"}
        />
      </div>

      <div className="space-y-2">
        <FieldLabel
          htmlFor="network-policy-domain-preset"
          label="Domain preset"
          description={
            <>
              Adds a maintained domain allowlist for common dependency or
              package manager traffic. Requires a supported FQDN policy
              provider.{" "}
              <ExternalDocsLink
                href={DOMAIN_PRESETS_DOCS_URL}
                className="underline"
                showIcon={false}
              >
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
          <SelectTrigger id="network-policy-domain-preset" className="w-full">
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
          description="Domain names or wildcard domains that workloads in Allowlist mode may reach. Requires a supported FQDN policy provider."
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
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      <div className="text-xs text-muted-foreground">{description}</div>
    </div>
  );
}

const EGRESS_MODE_LABELS: Record<EgressMode, string> = {
  off: "Block all",
  restricted: "Allowlist",
  unrestricted: "Public internet",
};

const EGRESS_MODE_DESCRIPTIONS: Record<EgressMode, string> = {
  off: "Block all outbound traffic.",
  restricted: "Allow only the CIDRs and domains configured below.",
  unrestricted:
    "Allow public destinations plus any additional CIDRs configured below.",
};

function formatEgressMode(mode: EgressMode) {
  return EGRESS_MODE_LABELS[mode];
}

function formatPolicySummary(policy: NetworkPolicy) {
  if (policy.egressMode === "off") return "No outbound egress";
  if (policy.egressMode === "unrestricted")
    return policy.allowedCidrs.length > 0
      ? `${policy.allowedCidrs.length} CIDR exception${policy.allowedCidrs.length === 1 ? "" : "s"}`
      : "Private ranges blocked in-cluster";

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
