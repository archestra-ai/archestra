// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type PermissionSubject,
  type ResourcePermissionAction,
  resourcePermissionPresets,
  type ScopedResource,
  TEAM_RESOURCE_SCOPE,
} from "@archestra/shared";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type ResourcePermissions as Policy,
  usePermissionRecipients,
  useResourcePermissions,
  useUpdateResourcePermissions,
} from "@/lib/resource-permissions.query";

export function ResourcePermissions({
  resource,
  scope,
  onDirtyChange,
  embedded = false,
}: {
  resource: ScopedResource;
  scope: string;
  onDirtyChange?: (dirty: boolean) => void;
  embedded?: boolean;
}) {
  const policy = useResourcePermissions(resource, scope);
  if (policy.isPending)
    return (
      <output className="text-sm text-muted-foreground">
        Loading permissions…
      </output>
    );
  if (policy.isError)
    return (
      <QueryLoadError
        title="Could not load permissions"
        description="Your access may have changed. Retry to check your current permissions."
        onRetry={() => void policy.refetch()}
      />
    );
  return (
    <PermissionsEditor
      key={`${resource}:${scope}`}
      policy={policy.data}
      onDirtyChange={onDirtyChange}
      embedded={embedded}
    />
  );
}

function PermissionsEditor({
  policy,
  onDirtyChange,
  embedded = false,
}: {
  policy: Policy;
  onDirtyChange?: (dirty: boolean) => void;
  embedded?: boolean;
}) {
  const form = useForm<{ revision: number; grants: Policy["grants"] }>({
    defaultValues: { revision: policy.revision, grants: policy.grants },
  });
  const dirty = form.formState.isDirty;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const { fields, append, remove, update } = useFieldArray({
    control: form.control,
    name: "grants",
  });
  const [search, setSearch] = useState("");
  const canManage = policy.effectiveActions.includes("manage-permissions");
  const recipients = usePermissionRecipients({
    resource: policy.resource,
    scope: policy.scope,
    query: search,
    enabled: canManage,
  });
  const mutation = useUpdateResourcePermissions(policy.resource, policy.scope);
  const changedElsewhere = policy.revision !== form.watch("revision");
  const reset = () =>
    form.reset({ revision: policy.revision, grants: policy.grants });
  const submit = form.handleSubmit((values) => {
    mutation.mutate(
      {
        revision: values.revision,
        grants: values.grants.map(({ subject, actions }) => ({
          subject,
          actions,
        })),
      },
      {
        onSuccess: (saved) =>
          form.reset({ revision: saved.revision, grants: saved.grants }),
      },
    );
  });
  // Direct grants are editable here; everything below them is explanation of
  // access that exists anyway. One list, ordered by who can change what, reads
  // as a single answer to "who has access" instead of three parallel boxes.
  const indirect = [
    ...policy.inheritedGrants.map((grant) => ({
      key: `inherited:${grant.sourceScope}:${subjectKey(grant.subject)}`,
      name: grant.name,
      type: grant.subject.type,
      actions: grant.actions,
      via:
        grant.sourceScope === TEAM_RESOURCE_SCOPE
          ? "every object their teams reach"
          : `every ${scopedResourceNouns[policy.resource]}`,
    })),
    ...policy.legacyAccess.map((grant) => ({
      key: `legacy:${subjectKey(grant.subject)}`,
      name: grant.name,
      type: grant.subject.type,
      actions: grant.actions,
      via: "existing roles and visibility",
    })),
  ];
  const Container = embedded ? "div" : "form";
  return (
    <Container
      onSubmit={embedded ? undefined : submit}
      className="max-w-3xl space-y-4"
    >
      <p className="text-sm text-muted-foreground">
        {policy.scope === "*"
          ? `Applies to every ${scopedResourceNouns[policy.resource]} in this organization, including ones created later.`
          : policy.scope === TEAM_RESOURCE_SCOPE
            ? "Applies to objects granted to a recipient's teams, and follows team membership as it changes. Service accounts have no teams."
            : "Access from every grant below is combined."}
      </p>
      {changedElsewhere && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
        >
          <span>Someone else changed these permissions while you edited.</span>
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            aria-label="Discard draft and reload"
            onClick={reset}
          >
            <span>Reload</span>
          </Button>
        </div>
      )}

      <div className="divide-y border-y">
        {fields.length === 0 && indirect.length === 0 && (
          <p className="py-3 text-sm text-muted-foreground">
            Nobody has access yet.
          </p>
        )}
        {fields.map((grant, index) => (
          <div key={grant.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{grant.name}</p>
              <p className="text-xs text-muted-foreground">
                {subjectLabels[grant.subject.type]}
              </p>
            </div>
            <Select
              disabled={!canManage || mutation.isPending}
              value={presetFor(grant.actions)}
              onValueChange={(preset) => {
                const choice =
                  resourcePermissionPresets[
                    preset as keyof typeof resourcePermissionPresets
                  ];
                if (choice)
                  update(index, { ...grant, actions: [...choice.actions] });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-36"
                aria-label={`Permission for ${grant.name}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(resourcePermissionPresets).map(
                  ([key, preset]) => (
                    <SelectItem
                      key={key}
                      value={key}
                      disabled={preset.actions.some(
                        (action) => !policy.effectiveActions.includes(action),
                      )}
                    >
                      {preset.label}
                    </SelectItem>
                  ),
                )}
                {presetFor(grant.actions) === "custom" && (
                  <SelectItem value="custom" disabled>
                    {actionSummary(grant.actions)}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 shrink-0 text-muted-foreground"
              disabled={!canManage || mutation.isPending}
              aria-label={`Remove direct access for ${grant.name}`}
              onClick={() => remove(index)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        {indirect.map((grant) => (
          <div
            key={grant.key}
            className="flex items-center gap-3 py-2 text-muted-foreground"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{grant.name}</p>
              <p className="text-xs">
                {`${subjectLabels[grant.type]} · via ${grant.via}`}
              </p>
            </div>
            <p className="shrink-0 text-xs">{actionSummary(grant.actions)}</p>
            <span className="size-8 shrink-0" />
          </div>
        ))}
      </div>

      {canManage && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SearchableSelect
            className="w-full max-w-xs"
            value=""
            ariaLabel="Add permission recipient"
            placeholder="Grant access to…"
            searchPlaceholder="Search recipients…"
            onSearchQueryChange={setSearch}
            items={(recipients.data ?? [])
              .filter(
                (recipient) =>
                  !fields.some(
                    (grant) =>
                      subjectKey(grant.subject) ===
                      subjectKey(recipient.subject),
                  ),
              )
              .map((recipient) => ({
                value: subjectKey(recipient.subject),
                label: recipient.name,
                description: subjectLabels[recipient.subject.type],
              }))}
            onValueChange={(key) => {
              const recipient = recipients.data?.find(
                (entry) => subjectKey(entry.subject) === key,
              );
              if (recipient) append({ ...recipient, actions: ["read"] });
            }}
            disabled={
              mutation.isPending || !policy.effectiveActions.includes("read")
            }
          />
          {dirty && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Discard changes"
                disabled={mutation.isPending}
                onClick={reset}
              >
                <span>Discard</span>
              </Button>
              <Button
                type={embedded ? "button" : "submit"}
                size="sm"
                aria-label="Save permissions"
                onClick={embedded ? () => void submit() : undefined}
                disabled={mutation.isPending || changedElsewhere}
              >
                <span>{mutation.isPending ? "Saving…" : "Save"}</span>
              </Button>
            </div>
          )}
        </div>
      )}
      {recipients.isError && (
        <p role="alert" className="text-sm text-destructive">
          <span>Could not load recipients. </span>
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={() => void recipients.refetch()}
          >
            <span>Retry</span>
          </Button>
        </p>
      )}
    </Container>
  );
}

function subjectKey(subject: PermissionSubject) {
  return `${subject.type}:${subject.id}`;
}
function presetFor(actions: ResourcePermissionAction[]) {
  return (
    Object.entries(resourcePermissionPresets).find(
      ([, preset]) =>
        preset.actions.length === actions.length &&
        preset.actions.every((action) => actions.includes(action)),
    )?.[0] ?? "custom"
  );
}
/**
 * The preset label when the actions are one, otherwise the actions themselves.
 * A row states its access once: the picker carries it for a direct grant, this
 * carries it for a grant that is only being explained.
 */
function actionSummary(actions: ResourcePermissionAction[]) {
  const preset = presetFor(actions);
  if (preset !== "custom")
    return resourcePermissionPresets[
      preset as keyof typeof resourcePermissionPresets
    ].label;
  return actions.map((action) => actionLabels[action]).join(", ");
}
/** Singular, for sentences. `resourceLabels` is plural and reads as "every agents". */
const scopedResourceNouns: Record<ScopedResource, string> = {
  agent: "agent",
  skill: "skill",
  app: "app",
  llmModel: "model",
  mcpGateway: "MCP gateway",
  mcpRegistry: "MCP registry entry",
};
const subjectLabels: Record<PermissionSubject["type"], string> = {
  user: "User",
  team: "Team",
  serviceAccount: "Service account",
  role: "Role",
  organization: "Organization",
};
const actionLabels: Record<ResourcePermissionAction, string> = {
  read: "View",
  use: "Use",
  update: "Edit",
  delete: "Delete",
  "manage-permissions": "Manage permissions",
};
