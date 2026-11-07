// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
"use client";

import { DocsPage } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Fingerprint, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { type UseFormReturn, useFieldArray, useForm } from "react-hook-form";
import { CopyableCode } from "@/components/copyable-code";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { FormDialog } from "@/components/form-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { TableRowActions } from "@/components/table-row-actions";
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
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import {
  type FederatedCredential,
  type FederatedCredentialBody,
  useDeleteFederatedCredential,
  useFederatedCredentials,
  useSaveFederatedCredential,
} from "@/lib/service-account-federated-credential.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

/**
 * Federated credentials of one service account: trust policies that let a CI
 * job or other workload sign in as the account with its own OIDC token, so no
 * API key has to be stored with it.
 */
export function FederatedCredentialsTab({
  serviceAccountId,
  canUpdate,
  createOpen,
  onCreateOpenChange,
}: {
  serviceAccountId: string;
  canUpdate: boolean;
  /** The create dialog; its button sits in the parent dialog's footer. */
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const { data, isPending, isLoadingError, refetch } =
    useFederatedCredentials(serviceAccountId);
  const deleteMutation = useDeleteFederatedCredential(serviceAccountId);
  const [editing, setEditing] = useState<FederatedCredential | null>(null);
  const [toDelete, setToDelete] = useState<FederatedCredential | null>(null);
  const docsUrl = getFrontendDocsUrl(DocsPage.PlatformWorkloadIdentity);

  const columns: ColumnDef<FederatedCredential>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        size: 140,
        cell: ({ row }) => (
          <div className="truncate font-medium" title={row.original.name}>
            {row.original.name}
          </div>
        ),
      },
      {
        accessorKey: "subject",
        header: "Issuer and subject",
        size: 260,
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <div
              className="truncate text-xs text-muted-foreground"
              title={row.original.issuer}
            >
              {issuerLabel(row.original.issuer)}
            </div>
            <div
              className="truncate font-mono text-xs"
              title={row.original.subject}
            >
              {row.original.subject}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "lastUsedAt",
        header: "Last used",
        size: 104,
        cell: ({ row }) =>
          row.original.lastUsedAt ? (
            formatRelativeTimeFromNow(row.original.lastUsedAt)
          ) : (
            <span className="text-muted-foreground">Never used</span>
          ),
      },
      ...(canUpdate
        ? [
            {
              id: "actions",
              header: "Actions",
              size: 84,
              cell: ({ row }) => (
                <TableRowActions
                  itemName={row.original.name}
                  actions={[]}
                  dropdownActions={[
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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Let a CI job or workload sign in as this account with an OIDC token from
        its own identity provider, such as GitHub Actions, GitLab CI,
        Kubernetes, or Google Cloud. No API key is stored with it: each token
        must match a credential below exactly, and is exchanged for a token that
        expires after one hour.{" "}
        {docsUrl ? (
          <ExternalDocsLink
            href={docsUrl}
            className="text-inherit underline underline-offset-4"
            showIcon={false}
          >
            How it works
          </ExternalDocsLink>
        ) : null}
      </p>

      <DataTable
        columns={columns}
        data={data ?? []}
        getRowId={(row) => row.id}
        isLoading={isPending}
        emptyIcon={Fingerprint}
        emptyMessage="No federated credentials"
        emptyDescription="Add one to let a workload sign in as this account without an API key."
        hidePaginationWhenSinglePage
        fixedWidthColumnIds={["lastUsedAt", "actions"]}
        flexibleColumnIds={["name", "subject"]}
      />

      {(data?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            Exchange a workload's OIDC token for an access token
          </p>
          <CopyableCode
            value={exchangeCommand(serviceAccountId)}
            toastMessage="Example request copied"
            className="break-all text-xs"
          />
        </div>
      )}

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
    </div>
  );
}

// === Internal helpers

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
};

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "github",
    label: "GitHub Actions",
    issuer: "https://token.actions.githubusercontent.com",
    subjectPlaceholder: "repo:my-org/my-repo:environment:production",
    claimsHint: "repository, ref, environment, job_workflow_ref",
  },
  {
    id: "gitlab",
    label: "GitLab.com",
    issuer: "https://gitlab.com",
    subjectPlaceholder:
      "project_path:my-group/my-project:ref_type:branch:ref:main",
    claimsHint: "project_path, ref, ref_protected, environment",
  },
  {
    id: "google",
    label: "Google Cloud",
    issuer: "https://accounts.google.com",
    subjectPlaceholder: "Numeric unique ID of the Google service account",
    claimsHint: "email, azp",
  },
  {
    id: "other",
    label: "Kubernetes or another OIDC issuer",
    issuer: "",
    subjectPlaceholder: "system:serviceaccount:my-namespace:my-service-account",
    claimsHint: "any top-level claim of the token",
  },
];

function FederatedCredentialDialog({
  serviceAccountId,
  credential,
  open,
  onOpenChange,
}: {
  serviceAccountId: string;
  credential: FederatedCredential | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  const preset =
    PROVIDER_PRESETS.find((p) => p.issuer && p.issuer === issuer) ??
    PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];

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
    if (saved) onOpenChange(false);
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
                if (next)
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
                    {p.label}
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
      <Label>Claim conditions</Label>
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => append({ claim: "", value: "" })}
      >
        <Plus className="h-4 w-4" />
        <span>Add condition</span>
      </Button>
    </div>
  );
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
