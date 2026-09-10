// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type PermissionSubject,
  type ResourcePermissionAction,
  resourceLabels,
  resourcePermissionPresets,
  type ScopedResource,
  TEAM_RESOURCE_SCOPE,
} from "@archestra/shared";
import { Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  const [showInherited, setShowInherited] = useState(true);
  const inheritedId = useId();
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
  const Container = embedded ? "div" : "form";
  return (
    <Container
      onSubmit={embedded ? undefined : submit}
      className="space-y-6 max-w-4xl"
    >
      <div>
        <h2 className="text-lg font-semibold">Who has access</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {policy.scope === "*"
            ? `Applies to all current and future ${resourceLabels[policy.resource].toLowerCase()} resources in this organization.`
            : policy.scope === TEAM_RESOURCE_SCOPE
              ? "Applies when the resource has a direct grant to one of the recipient’s teams. Access follows current team membership. Service accounts have no team membership."
              : `Permissions for ${policy.name}.`}{" "}
          Access from multiple grants is combined.
        </p>
      </div>
      {changedElsewhere && (
        <div role="alert" className="rounded-md border p-3 text-sm">
          Permissions changed while you were editing. Reload the latest
          permissions before saving.{" "}
          <Button type="button" variant="link" onClick={reset}>
            Discard draft and reload
          </Button>
        </div>
      )}
      <div className="divide-y rounded-md border">
        {fields.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            No direct grants. Inherited access can still apply.
          </p>
        )}
        {fields.map((grant, index) => (
          <div key={grant.id} className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-40 flex-1">
              <p className="text-sm font-medium break-words">{grant.name}</p>
              <p className="text-xs text-muted-foreground">
                {subjectLabels[grant.subject.type]} · Direct
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
                className="w-40"
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
                    Custom permissions
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={!canManage || mutation.isPending}
              aria-label={`Remove direct access for ${grant.name}`}
              onClick={() => remove(index)}
            >
              <Trash2 className="size-4" />
            </Button>
            <p className="w-full text-xs text-muted-foreground">
              {grant.actions.map((action) => actionLabels[action]).join(", ")}
            </p>
          </div>
        ))}
      </div>
      {canManage && (
        <div className="space-y-2">
          <SearchableSelect
            className="w-full max-w-md"
            value=""
            ariaLabel="Add permission recipient"
            placeholder="Add a user, team, service account, or role"
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
          {recipients.isError && (
            <p role="alert" className="text-sm text-destructive">
              Could not load recipients.{" "}
              <Button
                type="button"
                variant="link"
                onClick={() => void recipients.refetch()}
              >
                Retry
              </Button>
            </p>
          )}
        </div>
      )}
      <div className="space-y-3">
        <label
          htmlFor={inheritedId}
          className="flex items-center gap-2 text-sm"
        >
          <Checkbox
            id={inheritedId}
            checked={showInherited}
            onCheckedChange={(checked) => setShowInherited(checked === true)}
          />
          Show inherited grants
        </label>
        {showInherited && (
          <div className="space-y-3">
            {policy.inheritedGrants.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No grants inherited for this resource type.
              </p>
            ) : (
              policy.inheritedGrants.map((grant) => (
                <div
                  key={`${grant.sourceScope}:${subjectKey(grant.subject)}`}
                  className="flex flex-wrap gap-3 rounded-md border p-4"
                >
                  <div className="min-w-40 flex-1">
                    <p className="text-sm font-medium">{grant.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {subjectLabels[grant.subject.type]} ·{" "}
                      {grant.sourceScope === TEAM_RESOURCE_SCOPE
                        ? "Resources shared with the recipient’s teams"
                        : "All resources of this type"}
                    </p>
                  </div>
                  <p className="text-sm">
                    {grant.actions
                      .map((action) => actionLabels[action])
                      .join(", ")}
                  </p>
                </div>
              ))
            )}
            {policy.legacyAccess.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">
                  Existing roles and visibility
                </h3>
                <p className="text-xs text-muted-foreground">
                  These recipients also have access through organization roles
                  and the resource's existing visibility settings. Removing a
                  direct grant above does not remove this access.
                </p>
                <div className="divide-y rounded-md border">
                  {policy.legacyAccess.map((grant) => (
                    <div
                      key={subjectKey(grant.subject)}
                      className="flex flex-wrap gap-3 p-4"
                    >
                      <div className="min-w-40 flex-1">
                        <p className="text-sm font-medium">{grant.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {subjectLabels[grant.subject.type]} · Existing access
                        </p>
                      </div>
                      <p className="text-sm">
                        {grant.actions
                          .map((action) => actionLabels[action])
                          .join(", ")}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Inherited grants must be changed at their source. Removing a
              direct grant does not remove access from another grant.
            </p>
          </div>
        )}
      </div>
      {canManage && (
        <div className="flex items-center justify-end gap-2 border-t pt-4">
          <Button
            type="button"
            variant="outline"
            disabled={mutation.isPending || !form.formState.isDirty}
            onClick={reset}
          >
            Discard changes
          </Button>
          <Button
            type={embedded ? "button" : "submit"}
            onClick={embedded ? () => void submit() : undefined}
            disabled={
              mutation.isPending || !form.formState.isDirty || changedElsewhere
            }
          >
            {mutation.isPending ? "Saving…" : "Save permissions"}
          </Button>
        </div>
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
const subjectLabels = {
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
