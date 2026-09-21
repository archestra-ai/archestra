// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type PermissionSubject,
  type ResourcePermissionAction,
  resourcePermissionPresets,
  type ScopedResource,
  TEAM_RESOURCE_SCOPE,
} from "@archestra/shared";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Globe,
  Shield,
  Trash2,
  User,
  Users,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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
  description,
  showInherited = true,
}: {
  resource: ScopedResource;
  scope: string;
  onDirtyChange?: (dirty: boolean) => void;
  embedded?: boolean;
  description?: ReactNode;
  showInherited?: boolean;
}) {
  const policy = useResourcePermissions(resource, scope);
  if (policy.isPending)
    return (
      <div className="max-w-3xl space-y-4">
        <output className="sr-only">Loading permissions…</output>
        {[0, 1].map((row) => (
          <div
            key={row}
            className="flex items-center justify-between py-3"
            aria-hidden="true"
          >
            <div className="space-y-2">
              <Skeleton className="h-4 w-32 motion-reduce:animate-none" />
              <Skeleton className="h-3 w-16 motion-reduce:animate-none" />
            </div>
            <Skeleton className="h-8 w-36 motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    );
  if (policy.isError && !policy.data)
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
      refreshFailed={policy.isError}
      onRetry={() => void policy.refetch()}
      onDirtyChange={onDirtyChange}
      embedded={embedded}
      description={description}
      showInherited={showInherited}
    />
  );
}

function PermissionsEditor({
  policy,
  refreshFailed,
  onRetry,
  onDirtyChange,
  embedded = false,
  description,
  showInherited,
}: {
  policy: Policy;
  refreshFailed: boolean;
  onRetry: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  embedded?: boolean;
  description?: ReactNode;
  showInherited: boolean;
}) {
  const recipientInputId = useId();
  const form = useForm<{ revision: number; grants: Policy["grants"] }>({
    defaultValues: { revision: policy.revision, grants: policy.grants },
  });
  const dirty = form.formState.isDirty;
  useEffect(() => {
    if (!dirty) {
      form.reset({ revision: policy.revision, grants: policy.grants });
    }
  }, [dirty, form, policy.revision, policy.grants]);
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
  const changedElsewhere = dirty && policy.revision !== form.watch("revision");
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
    ...(showInherited ? policy.inheritedGrants : []).map((grant) => ({
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
      {description !== null && (
        <p className="text-sm text-muted-foreground">
          {description ??
            (policy.scope === "*"
              ? `Applies to every ${scopedResourceNouns[policy.resource]} in this organization, including ones created later.`
              : policy.scope === TEAM_RESOURCE_SCOPE
                ? "Applies to objects granted to a recipient's teams, and follows team membership as it changes. Service accounts have no teams."
                : "Access from every grant below is combined.")}
        </p>
      )}
      {refreshFailed && (
        <InlineNotice variant="error">
          <AlertCircle />
          <span className="font-medium">Could not refresh permissions.</span>
          <InlineNoticeText>
            {dirty
              ? "Your draft is preserved. Retry before saving."
              : "Showing the last loaded permissions. Retry to see current access."}
          </InlineNoticeText>
          <Button
            type="button"
            variant="link"
            className="ml-auto h-auto p-0"
            onClick={onRetry}
          >
            <span>Retry</span>
          </Button>
        </InlineNotice>
      )}
      {changedElsewhere && !mutation.isPending && (
        <InlineNotice>
          <AlertTriangle />
          <span className="font-medium">Permissions changed.</span>
          <InlineNoticeText>
            Someone else changed these permissions while you edited.
          </InlineNoticeText>
          <Button
            type="button"
            variant="link"
            className="ml-auto h-auto p-0"
            aria-label="Discard draft and reload"
            onClick={reset}
          >
            <span>Reload</span>
          </Button>
        </InlineNotice>
      )}

      <div className="divide-y">
        {(fields.length > 0 || indirect.length > 0) && (
          <div className="flex items-center gap-3 pb-2 text-xs font-medium text-muted-foreground">
            <span className="flex-1">Recipient</span>
            <span className="w-36">Permission</span>
            <span className="size-8" />
          </div>
        )}
        {fields.length === 0 && indirect.length === 0 && (
          <p className="py-3 text-sm text-muted-foreground">
            {policy.scope === TEAM_RESOURCE_SCOPE
              ? "No additional access through teams."
              : "Nobody has access yet."}
          </p>
        )}
        {fields.map((grant, index) => (
          <div key={grant.id} className="flex items-center gap-3 py-3">
            <SubjectIcon type={grant.subject.type} />
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium">{grant.name}</p>
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
                className="h-auto min-h-8 w-36 shrink-0 border-transparent text-left shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted [&_[data-slot=select-value]]:line-clamp-none [&_[data-slot=select-value]]:whitespace-normal"
                aria-label={`Permission for ${grant.name}`}
              >
                <SelectValue>{actionSummary(grant.actions)}</SelectValue>
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
                      <span className="block font-medium">{preset.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {
                          presetDescriptions[
                            key as keyof typeof resourcePermissionPresets
                          ]
                        }
                      </span>
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
            className="flex items-center gap-3 py-3 text-muted-foreground"
          >
            <SubjectIcon type={grant.type} />
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium">{grant.name}</p>
              <p className="text-xs">
                {`${subjectLabels[grant.type]} · via ${grant.via}`}
              </p>
            </div>
            <p className="w-36 shrink-0 text-xs">
              {actionSummary(grant.actions)}
            </p>
            <span className="size-8 shrink-0" />
          </div>
        ))}
      </div>

      {canManage && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="w-full max-w-xs space-y-2">
            <Label htmlFor={recipientInputId}>Add recipient</Label>
            <SearchableSelect
              id={recipientInputId}
              className="w-full max-w-xs"
              value=""
              ariaLabel="Add permission recipient"
              placeholder="Choose who to add…"
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
          </div>
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
                disabled={
                  mutation.isPending || changedElsewhere || refreshFailed
                }
              >
                <span>{mutation.isPending ? "Saving…" : "Save"}</span>
              </Button>
            </div>
          )}
        </div>
      )}
      {recipients.isError && (
        <InlineNotice variant="error">
          <AlertCircle />
          <span className="font-medium">Could not load recipients.</span>
          <Button
            type="button"
            variant="link"
            className="ml-auto h-auto p-0"
            onClick={() => void recipients.refetch()}
          >
            <span>Retry</span>
          </Button>
        </InlineNotice>
      )}
    </Container>
  );
}

function SubjectIcon({ type }: { type: PermissionSubject["type"] }) {
  const Icon = {
    user: User,
    team: Users,
    role: Shield,
    serviceAccount: Bot,
    organization: Globe,
  }[type];
  return (
    <Icon
      className="hidden size-4 shrink-0 text-muted-foreground sm:block"
      aria-hidden="true"
    />
  );
}

function subjectKey(subject: PermissionSubject) {
  return `${subject.type}:${subject.id}`;
}
/** @public - shared with initial-resource-permissions.tsx */
export function presetFor(actions: ResourcePermissionAction[]) {
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
  project: "project",
  plugin: "plugin",
  knowledgeBase: "knowledge base",
  knowledgeConnector: "connector",
  knowledgeFile: "file",
  llmVirtualKey: "virtual key",
  llmProviderApiKey: "provider key",
  environment: "environment",
  scheduledTask: "scheduled task",
  log: "log",
  auditLog: "audit log entry",
  serviceAccount: "service account",
};
/** @public - shared with initial-resource-permissions.tsx */
export const subjectLabels: Record<PermissionSubject["type"], string> = {
  user: "User",
  team: "Team",
  serviceAccount: "Service account",
  role: "Role",
  organization: "Organization",
};
const presetDescriptions: Record<
  keyof typeof resourcePermissionPresets,
  string
> = {
  view: "View without making changes",
  use: "View and use the resource",
  edit: "View, use, and edit the resource",
  manage: "Also delete the resource and manage permissions",
};
const actionLabels: Record<ResourcePermissionAction, string> = {
  read: "View",
  use: "Use",
  update: "Edit",
  delete: "Delete",
  "manage-permissions": "Manage permissions",
};
