// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
"use client";

import { DocsPage } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Fingerprint,
  KeyRound,
  ListFilter,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { type UseFormReturn, useFieldArray, useForm } from "react-hook-form";
import {
  type SimpleIcon,
  siGithubactions,
  siGitlab,
  siGooglecloud,
  siKubernetes,
} from "simple-icons";
import { CopyableCode } from "@/components/copyable-code";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { FormDialog } from "@/components/form-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import {
  type FederatedCredential,
  type FederatedCredentialBody,
  useBulkDeleteFederatedCredentials,
  useDeleteFederatedCredential,
  useFederatedCredentials,
  useSaveFederatedCredential,
} from "@/lib/service-account-federated-credential.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";

/**
 * Federated credentials of one service account: trust policies that let a CI
 * job or other workload sign in as the account with its own OIDC token, so no
 * API key has to be stored with it. Laid out like the account's API keys tab:
 * filters and the Add button on one row, then the table.
 */
export function FederatedCredentialsSection({
  serviceAccountId,
  canUpdate,
  createOpen,
  onCreateOpenChange,
}: {
  serviceAccountId: string;
  canUpdate: boolean;
  /** The add dialog, opened from the page header's Add credential button. */
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const { data, isPending, isLoadingError, refetch } =
    useFederatedCredentials(serviceAccountId);
  const credentials = data ?? [];
  const deleteMutation = useDeleteFederatedCredential(serviceAccountId);
  const bulkDelete = useBulkDeleteFederatedCredentials(serviceAccountId);
  const [editing, setEditing] = useState<FederatedCredential | null>(null);
  const [toDelete, setToDelete] = useState<FederatedCredential | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [added, setAdded] = useState<FederatedCredential | null>(null);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState(ALL);

  const hasActiveFilters = search.trim().length > 0 || providerFilter !== ALL;
  const clearFilters = useCallback(() => {
    setSearch("");
    setProviderFilter(ALL);
  }, []);

  // Only the providers the account actually trusts are worth filtering by.
  // Each label keeps one of its issuers, so its option can show the logo.
  const providers = useMemo(() => {
    const issuerByLabel = new Map<string, string>();
    for (const c of credentials) {
      issuerByLabel.set(providerLabel(c.issuer), c.issuer);
    }
    return [...issuerByLabel.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [credentials]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return credentials.filter((credential) => {
      if (
        query &&
        !credential.name.toLowerCase().includes(query) &&
        !credential.subject.toLowerCase().includes(query)
      ) {
        return false;
      }
      if (
        providerFilter !== ALL &&
        providerLabel(credential.issuer) !== providerFilter
      ) {
        return false;
      }
      return true;
    });
  }, [credentials, search, providerFilter]);

  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected,
  } = useBulkSelection({
    rows: filtered,
    getId: (credential) => credential.id,
    filterSignature: `${serviceAccountId}|${search}|${providerFilter}`,
  });

  const columns: ColumnDef<FederatedCredential>[] = useMemo(
    () => [
      ...(canUpdate
        ? [
            createSelectColumn<FederatedCredential>({
              rowLabel: (credential) => `Select ${credential.name}`,
              allLabel: "Select all federated credentials on this page",
            }),
          ]
        : []),
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        size: 320,
        cell: ({ row }) => {
          const label = providerLabel(row.original.issuer);
          return (
            // The subject sits under the name, as a virtual key's prefix does:
            // together they say which workload this trusts.
            <div className="flex min-w-0 items-center gap-2.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex shrink-0">
                    <ProviderLogo
                      preset={presetForIssuer(row.original.issuer)}
                      className="size-5"
                    />
                    <span className="sr-only">{label}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium" title={row.original.name}>
                  {row.original.name}
                </div>
                <code
                  className="block truncate font-mono text-xs text-muted-foreground"
                  title={row.original.subject}
                >
                  {row.original.subject}
                </code>
              </div>
            </div>
          );
        },
      },
      {
        id: "conditions",
        header: "Conditions",
        size: 120,
        cell: ({ row }) => (
          <ClaimConditionsCell conditions={row.original.claimConditions} />
        ),
      },
      {
        accessorKey: "lastUsedAt",
        header: "Last used",
        size: 130,
        cell: ({ row }) =>
          row.original.lastUsedAt ? (
            formatRelativeTimeFromNow(row.original.lastUsedAt, { strict: true })
          ) : (
            <span className="text-muted-foreground">Never</span>
          ),
      },
      ...(canUpdate
        ? [
            {
              id: "actions",
              header: "Actions",
              // Two icon buttons plus the cell's padding; any narrower and
              // they press against the table's right edge.
              size: 100,
              cell: ({ row }) => (
                <TableRowActions
                  itemName={row.original.name}
                  actions={[
                    {
                      icon: <Pencil className="h-4 w-4" />,
                      label: "Edit federated credential",
                      onClick: () => setEditing(row.original),
                    },
                    {
                      icon: <Trash2 className="h-4 w-4" />,
                      label: "Delete federated credential",
                      onClick: () => setToDelete(row.original),
                      variant: "destructive" as const,
                    },
                  ]}
                />
              ),
            } satisfies ColumnDef<FederatedCredential>,
          ]
        : []),
    ],
    [canUpdate],
  );

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load federated credentials"
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <BulkActionsScope>
      <section className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Let CI jobs and other workloads sign in with their own OIDC token,
          with no secret to store or rotate.
        </p>
        {credentials.length > 0 && (
          <CollectionFilters>
            <FilterBar
              onClearFilters={hasActiveFilters ? clearFilters : undefined}
              search={
                <SearchInput
                  objectNamePlural="credentials"
                  searchFields={["name", "subject"]}
                  className={filterSearchClass}
                  syncQueryParams={false}
                  value={search}
                  onSearchChange={setSearch}
                />
              }
            >
              {providers.length > 1 && (
                <FilterSelect
                  value={providerFilter}
                  onValueChange={setProviderFilter}
                  placeholder="Filter by provider"
                  items={[
                    {
                      value: ALL,
                      label: "All providers",
                      content: (
                        <span className="inline-flex items-center gap-1.5 text-sm">
                          <ListFilter
                            aria-hidden
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                          All providers
                        </span>
                      ),
                    },
                    ...providers.map(([label, issuer]) => ({
                      value: label,
                      label,
                      content: (
                        <span className="inline-flex items-center gap-1.5 text-sm">
                          <ProviderLogo
                            preset={presetForIssuer(issuer)}
                            className="size-3.5"
                          />
                          {label}
                        </span>
                      ),
                    })),
                  ]}
                />
              )}
            </FilterBar>
          </CollectionFilters>
        )}

        {canUpdate && (
          <BulkActions
            count={selected.length}
            noun="federated credential"
            onClear={clearSelection}
            busy={bulkDelete.isPending}
          >
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
              <span>Delete</span>
            </Button>
          </BulkActions>
        )}

        <DataTable
          columns={columns}
          data={filtered}
          getRowId={(row) => row.id}
          isLoading={isPending}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          onPageRowIdsChange={onPageRowIdsChange}
          hideSelectedCount
          emptyIcon={Fingerprint}
          emptyMessage="No federated credentials"
          emptyDescription="Add one to let a CI job sign in as this account without an API key."
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage="No federated credentials match your filters"
          onClearFilters={clearFilters}
          hidePaginationWhenSinglePage
          fixedWidthColumnIds={["conditions", "lastUsedAt", "actions"]}
          flexibleColumnIds={["name"]}
        />

        <FederatedCredentialDialog
          key={editing?.id ?? "new"}
          serviceAccountId={serviceAccountId}
          credential={editing}
          open={createOpen || !!editing}
          onOpenChange={(open) => {
            if (open) return;
            setEditing(null);
            onCreateOpenChange(false);
          }}
          onAdded={setAdded}
        />
        <CredentialAddedDialog
          credential={added}
          serviceAccountId={serviceAccountId}
          onClose={() => setAdded(null)}
        />
        <DeleteConfirmDialog
          open={!!toDelete}
          onOpenChange={(open) => !open && setToDelete(null)}
          title="Delete federated credential"
          description="Workloads that use it can no longer sign in, and the tokens it issued stop working at once."
          isPending={deleteMutation.isPending}
          onConfirm={async () => {
            if (!toDelete) return;
            await deleteMutation.mutateAsync(toDelete.id);
            setToDelete(null);
          }}
          confirmLabel="Delete"
          pendingLabel="Deleting..."
        />
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="Delete federated credentials"
          description={`Delete ${selected.length} ${
            selected.length === 1
              ? "federated credential"
              : "federated credentials"
          }? Workloads that use them can no longer sign in, and the tokens they issued stop working at once.`}
          isPending={bulkDelete.isPending}
          onConfirm={() =>
            bulkDelete.mutate(selected, {
              onSuccess: (outcome) => {
                reportBulkOutcome({
                  outcome,
                  verb: "Deleted",
                  failureVerb: "delete",
                  noun: "federated credential",
                });
                setBulkDeleteOpen(false);
                if (outcome.failed.length === 0) clearSelection();
              },
            })
          }
          confirmLabel="Delete"
          pendingLabel="Deleting..."
        />
      </section>
    </BulkActionsScope>
  );
}

// === Internal helpers

const ALL = "all";

/**
 * Shown once, right after a credential is added: the request a workload makes
 * with its OIDC token, the account's id already filled in. The same moment an
 * API key shows its example request.
 */
function CredentialAddedDialog({
  credential,
  serviceAccountId,
  onClose,
}: {
  credential: FederatedCredential | null;
  serviceAccountId: string;
  onClose: () => void;
}) {
  const docsUrl = getFrontendDocsUrl(DocsPage.PlatformWorkloadIdentity);
  return (
    <FormDialog
      open={!!credential}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Federated credential added"
      size="medium"
    >
      <DialogBody className="space-y-2">
        <Label>Sign in from the workload</Label>
        <FieldDescription>
          Exchange the workload&apos;s OIDC token for an Archestra token, then
          send that as a Bearer token.{" "}
          {docsUrl ? (
            <ExternalDocsLink href={docsUrl}>How it works</ExternalDocsLink>
          ) : null}
        </FieldDescription>
        <CopyableCode
          value={exchangeCommand(serviceAccountId)}
          toastMessage="Request copied"
          className="break-all text-xs"
        />
      </DialogBody>
      <DialogStickyFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

/** How many extra claims a token must carry, with the claims on hover. */
function ClaimConditionsCell({
  conditions,
}: {
  conditions: Record<string, string>;
}) {
  const entries = Object.entries(conditions);
  if (entries.length === 0) {
    return <span className="text-muted-foreground">None</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default underline decoration-dotted underline-offset-4">
          {entries.length} {entries.length === 1 ? "claim" : "claims"}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <div className="space-y-0.5 font-mono text-xs">
          {entries.map(([claim, value]) => (
            <div key={claim} className="break-all">
              {claim} = {value}
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

type ConditionRow = { claim: string; value: string };

type FormValues = {
  name: string;
  issuer: string;
  audience: string;
  subject: string;
  conditions: ConditionRow[];
};

type ProviderPreset = {
  id: string;
  label: string;
  issuer: string;
  subjectPlaceholder: string;
  claimsHint: string;
  logo: SimpleIcon | null;
};

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "github",
    label: "GitHub Actions",
    issuer: "https://token.actions.githubusercontent.com",
    subjectPlaceholder: "repo:my-org/my-repo:environment:production",
    claimsHint: "repository, ref, environment, job_workflow_ref",
    logo: siGithubactions,
  },
  {
    id: "gitlab",
    label: "GitLab.com",
    issuer: "https://gitlab.com",
    subjectPlaceholder:
      "project_path:my-group/my-project:ref_type:branch:ref:main",
    claimsHint: "project_path, ref, ref_protected, environment",
    logo: siGitlab,
  },
  {
    id: "google",
    label: "Google Cloud",
    issuer: "https://accounts.google.com",
    subjectPlaceholder: "Numeric unique ID of the Google service account",
    claimsHint: "email, azp",
    logo: siGooglecloud,
  },
  {
    // A cluster's issuer is its own URL, so this preset leaves it blank.
    id: "kubernetes",
    label: "Kubernetes",
    issuer: "",
    subjectPlaceholder: "system:serviceaccount:my-namespace:my-service-account",
    claimsHint: "any top-level claim of the token",
    logo: siKubernetes,
  },
  {
    id: "other",
    label: "Another OIDC issuer",
    issuer: "",
    subjectPlaceholder: "The token's sub claim",
    claimsHint: "any top-level claim of the token",
    logo: null,
  },
];

/**
 * Which preset an issuer belongs to. Managed Kubernetes issuers (GKE, EKS,
 * AKS) are recognised by host, so a cluster's credential shows its logo.
 */
function presetForIssuer(issuer: string): ProviderPreset {
  const exact = PROVIDER_PRESETS.find((p) => p.issuer && p.issuer === issuer);
  if (exact) return exact;
  if (KUBERNETES_ISSUER_HOST.test(hostOf(issuer))) {
    return PROVIDER_PRESETS.find((p) => p.id === "kubernetes") ?? OTHER_PRESET;
  }
  return OTHER_PRESET;
}

const OTHER_PRESET = PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];

const KUBERNETES_ISSUER_HOST =
  /^(container\.googleapis\.com|oidc\.eks\.[a-z0-9-]+\.amazonaws\.com|[a-z0-9.-]*\.oic\.prod-aks\.azure\.com|kubernetes\.default\.svc.*)$/;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The provider's brand mark, or a neutral key for any other issuer. */
function ProviderLogo({
  preset,
  className,
}: {
  preset: ProviderPreset;
  className?: string;
}) {
  if (!preset.logo) {
    return (
      <KeyRound
        aria-hidden
        className={cn("size-4 shrink-0 text-muted-foreground", className)}
      />
    );
  }
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill={`#${preset.logo.hex}`}
      className={cn("size-4 shrink-0", className)}
    >
      <path d={preset.logo.path} />
    </svg>
  );
}

function FederatedCredentialDialog({
  serviceAccountId,
  credential,
  open,
  onOpenChange,
  onAdded,
}: {
  serviceAccountId: string;
  credential: FederatedCredential | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with a newly added credential (not on edit). */
  onAdded: (credential: FederatedCredential) => void;
}) {
  const save = useSaveFederatedCredential(serviceAccountId);
  const form = useForm<FormValues>({
    defaultValues: credential
      ? {
          name: credential.name,
          issuer: credential.issuer,
          audience: credential.audience,
          subject: credential.subject,
          conditions: Object.entries(credential.claimConditions).map(
            ([claim, value]) => ({ claim, value }),
          ),
        }
      : {
          name: "",
          issuer: PROVIDER_PRESETS[0].issuer,
          audience: defaultAudience(),
          subject: "",
          conditions: [],
        },
  });
  const issuer = form.watch("issuer");
  // Kept apart from the issuer: Kubernetes and "another issuer" both start
  // from a blank one, so the issuer alone can't say which was picked.
  const [presetId, setPresetId] = useState(
    () => presetForIssuer(credential?.issuer ?? PROVIDER_PRESETS[0].issuer).id,
  );
  const preset =
    PROVIDER_PRESETS.find((p) => p.id === presetId) ?? OTHER_PRESET;

  const handleSubmit = form.handleSubmit(async (values) => {
    const body: FederatedCredentialBody = {
      name: values.name.trim(),
      issuer: values.issuer.trim(),
      audience: values.audience.trim(),
      subject: values.subject.trim(),
      claimConditions: Object.fromEntries(
        values.conditions
          .filter((row) => row.claim.trim())
          .map((row) => [row.claim.trim(), row.value.trim()]),
      ),
    };
    const saved = await save
      .mutateAsync({ credentialId: credential?.id, body })
      // Errors were toasted; keep the dialog open to fix them.
      .catch(() => null);
    if (!saved) return;
    onOpenChange(false);
    if (!credential) onAdded(saved);
  });

  const isComplete =
    form.watch("name").trim() &&
    issuer.trim() &&
    form.watch("audience").trim() &&
    form.watch("subject").trim();

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        credential ? "Edit federated credential" : "Add federated credential"
      }
      description="Tokens are trusted only when the issuer, audience, subject, and every condition match exactly."
      size="medium"
      isDirty={form.formState.isDirty}
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={handleSubmit}
      >
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="federated-credential-name">Name</Label>
            <Input
              id="federated-credential-name"
              placeholder="infra apply on main"
              {...form.register("name", { required: true })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="federated-credential-provider">
              Identity provider
            </Label>
            <Select
              value={preset.id}
              onValueChange={(id) => {
                const next = PROVIDER_PRESETS.find((p) => p.id === id);
                if (!next) return;
                setPresetId(next.id);
                form.setValue("issuer", next.issuer, { shouldDirty: true });
              }}
            >
              <SelectTrigger
                id="federated-credential-provider"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex items-center gap-2">
                      <ProviderLogo preset={p} />
                      {p.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="federated-credential-issuer">Issuer URL</Label>
            <Input
              id="federated-credential-issuer"
              placeholder="https://oidc.example.com"
              {...form.register("issuer", { required: true })}
            />
            <FieldDescription>
              The token&apos;s <code>iss</code> claim, exactly. It must be a
              public https URL that serves an OIDC discovery document.
            </FieldDescription>
          </div>
          <div className="space-y-2">
            <Label htmlFor="federated-credential-audience">Audience</Label>
            <Input
              id="federated-credential-audience"
              {...form.register("audience", { required: true })}
            />
            <FieldDescription>
              A value the token&apos;s <code>aud</code> claim must contain.
              Request the token with this audience.
            </FieldDescription>
          </div>
          <div className="space-y-2">
            <Label htmlFor="federated-credential-subject">Subject</Label>
            <Input
              id="federated-credential-subject"
              placeholder={preset.subjectPlaceholder}
              className="font-mono text-sm"
              {...form.register("subject", { required: true })}
            />
            <FieldDescription>
              The token&apos;s <code>sub</code> claim, exactly. Wildcards are
              not supported.
            </FieldDescription>
          </div>
          <ClaimConditionsField form={form} hint={preset.claimsHint} />
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending || !isComplete}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>{credential ? "Save" : "Add"}</span>
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function ClaimConditionsField({
  form,
  hint,
}: {
  form: UseFormReturn<FormValues>;
  hint: string;
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "conditions",
  });
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Claim conditions</Label>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Add condition"
          title="Add condition"
          onClick={() => append({ claim: "", value: "" })}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <FieldDescription>
        Optional. Each claim must equal its value exactly. Common claims: {hint}
        .
      </FieldDescription>
      {fields.map((field, index) => (
        <div key={field.id} className="flex items-center gap-2">
          <Input
            aria-label={`Claim ${index + 1}`}
            placeholder="repository"
            className="font-mono text-sm"
            {...form.register(`conditions.${index}.claim`)}
          />
          <Input
            aria-label={`Value ${index + 1}`}
            placeholder="my-org/my-repo"
            className="font-mono text-sm"
            {...form.register(`conditions.${index}.value`)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove condition ${index + 1}`}
            onClick={() => remove(index)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

/** The provider's name, or the issuer's host for any other issuer. */
function providerLabel(issuer: string): string {
  const preset = presetForIssuer(issuer);
  return preset === OTHER_PRESET ? issuerLabel(issuer) : preset.label;
}

function issuerLabel(issuer: string): string {
  const preset = PROVIDER_PRESETS.find((p) => p.issuer === issuer);
  if (preset) return preset.label;
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

/** This deployment's own URL: a value nothing else would ask a CI token for. */
function defaultAudience(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

function exchangeCommand(serviceAccountId: string): string {
  const origin =
    typeof window === "undefined"
      ? "https://your-host"
      : window.location.origin;
  return [
    `curl -s ${origin}/api/workload-identity/token`,
    "-d grant_type=urn:ietf:params:oauth:grant-type:token-exchange",
    "-d subject_token_type=urn:ietf:params:oauth:token-type:jwt",
    '-d subject_token="$OIDC_TOKEN"',
    `-d service_account_id=${serviceAccountId}`,
  ].join(" ");
}
