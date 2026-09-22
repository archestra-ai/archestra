// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  ORGANIZATION_WIDE_RESOURCES,
  type PermissionSubject,
  type ResourcePermissionAction,
  resourcePermissionPresets,
  type ScopedResource,
} from "@archestra/shared";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Globe,
  Info,
  Plus,
  Shield,
  Trash2,
  User,
  Users,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useFieldArray, useForm } from "react-hook-form";
import {
  AddResourceAccessDialog,
  ResourceAccessPicker,
} from "@/components/add-resource-access-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
import { Skeleton } from "@/components/ui/skeleton";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import {
  type ResourcePermissions as Policy,
  useResourcePermissions,
  useUpdateResourcePermissions,
} from "@/lib/resource-permissions.query";

export function ResourcePermissions({
  resource,
  scope,
  onDirtyChange,
  embedded = false,
  title,
  description,
  showInherited = true,
}: {
  resource: ScopedResource;
  scope: string;
  onDirtyChange?: (dirty: boolean) => void;
  embedded?: boolean;
  title?: string;
  description?: ReactNode;
  showInherited?: boolean;
}) {
  const policy = useResourcePermissions(resource, scope);
  if (policy.isPending)
    return (
      <div className="space-y-4">
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
      title={title}
      description={description}
      showInherited={showInherited}
    />
  );
}

/** Shared by resource lists and the explanation of inherited access. */
export function ResourcePermissionsDialog({
  resource,
  scope = "*",
  title,
  open,
  onOpenChange,
}: {
  resource: ScopedResource;
  scope?: string;
  title?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [isDirty, setIsDirty] = useState(false);
  const [footerContainer, setFooterContainer] =
    useState<HTMLFieldSetElement | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessDirty, setAccessDirty] = useState(false);
  const noun = scopedResourceNouns[resource];
  return (
    <StandardDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setAccessOpen(false);
          setAccessDirty(false);
        }
        onOpenChange(next);
      }}
      title={
        accessOpen
          ? "Add access"
          : (title ?? `Permissions for all ${resourcePluralNames[resource]}`)
      }
      description={
        accessOpen
          ? "Choose who to add and set what each recipient can do."
          : scope !== "*"
            ? `Choose who can access this ${noun} and what they can do.`
            : `Give access to every ${noun} in the organization, including ones created later.` +
              (ORGANIZATION_WIDE_RESOURCES.has(resource)
                ? ""
                : " Permissions on individual resources can add access, but cannot reduce access given here.")
      }
      isDirty={isDirty || accessDirty}
      className="sm:max-w-3xl"
      footer={
        <fieldset
          ref={setFooterContainer}
          aria-label="Permission actions"
          className="flex min-w-0 w-full justify-end"
        >
          {!isDirty && !accessOpen && (
            <DialogCancelButton>Done</DialogCancelButton>
          )}
        </fieldset>
      }
    >
      <ResourcePermissionsDialogContext.Provider
        value={{ footerContainer, setAccessOpen, setAccessDirty }}
      >
        {open && (
          <ResourcePermissions
            resource={resource}
            scope={scope}
            embedded
            description={null}
            onDirtyChange={setIsDirty}
          />
        )}
      </ResourcePermissionsDialogContext.Provider>
    </StandardDialog>
  );
}

function PermissionsEditor({
  policy,
  refreshFailed,
  onRetry,
  onDirtyChange,
  embedded = false,
  title,
  description,
  showInherited,
}: {
  policy: Policy;
  refreshFailed: boolean;
  onRetry: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  embedded?: boolean;
  title?: string;
  description?: ReactNode;
  showInherited: boolean;
}) {
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
  const dialog = useContext(ResourcePermissionsDialogContext);
  const footerContainer = dialog?.footerContainer;
  const [addOpen, setAddOpen] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const wasAdding = useRef(false);
  useEffect(() => {
    if (dialog && wasAdding.current && !addOpen) addButton.current?.focus();
    wasAdding.current = addOpen;
  }, [addOpen, dialog]);
  const setAccessOpen = (open: boolean) => {
    setAddOpen(open);
    dialog?.setAccessOpen(open);
  };
  const [allPermissionsOpen, setAllPermissionsOpen] = useState(false);
  const canManage = policy.effectiveActions.includes("manage-permissions");
  const presets = presetsFor(policy.resource);
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
      source: "all" as const,
      via: `Every ${scopedResourceNouns[policy.resource]}`,
      explanation: `Applies to every ${scopedResourceNouns[policy.resource]}, including new ones.`,
    })),
    ...policy.legacyAccess.map((grant) => ({
      key: `legacy:${subjectKey(grant.subject)}`,
      name: grant.name,
      type: grant.subject.type,
      actions: grant.actions,
      source: "legacy" as const,
      via: "Existing access",
      explanation:
        "This access comes from existing roles and sharing settings. It cannot be changed in this list.",
    })),
  ];
  const Container = embedded ? "div" : "form";
  const noun = scopedResourceNouns[policy.resource];
  const explanation =
    description === undefined
      ? policy.scope === "*"
        ? `Applies to every ${scopedResourceNouns[policy.resource]}, including ones created later.`
        : `Choose who can access this ${noun} and what they can do.`
      : description;
  const actions =
    canManage && dirty && !(dialog && addOpen) ? (
      <div
        className={`flex w-full items-center justify-between gap-3 ${footerContainer === undefined ? "border-t pt-3" : ""}`}
      >
        <span className="text-xs text-muted-foreground">Unsaved changes</span>
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
            type={
              embedded || footerContainer !== undefined ? "button" : "submit"
            }
            size="sm"
            aria-label="Save permissions"
            onClick={
              embedded || footerContainer !== undefined
                ? () => void submit()
                : undefined
            }
            disabled={mutation.isPending || changedElsewhere || refreshFailed}
          >
            <span>{mutation.isPending ? "Saving…" : "Save"}</span>
          </Button>
        </div>
      </div>
    ) : null;
  const AccessPicker = dialog ? ResourceAccessPicker : AddResourceAccessDialog;
  return (
    <>
      <Container
        hidden={!!dialog && addOpen}
        onSubmit={embedded ? undefined : submit}
        className="space-y-3"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-semibold">
              {title ?? "Who has access"}
            </h2>
            {explanation && (
              <p className="max-w-prose text-sm text-muted-foreground">
                {explanation}
              </p>
            )}
          </div>
          {canManage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={
                mutation.isPending || !policy.effectiveActions.includes("read")
              }
              ref={addButton}
              onClick={() => setAccessOpen(true)}
            >
              <Plus className="size-4" />
              <span>Add access</span>
            </Button>
          )}
        </div>
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
              <span className="w-36 border border-transparent px-3">
                Permission
              </span>
              <span className="size-8" />
            </div>
          )}
          {fields.length === 0 && indirect.length === 0 && (
            <p className="py-3 text-sm text-muted-foreground">
              Nobody has access yet.
            </p>
          )}
          {fields.map((grant, index) => (
            <div key={grant.id} className="flex items-center gap-3 py-1.5">
              <SubjectIcon type={grant.subject.type} />
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                <p className="break-words text-sm font-medium">{grant.name}</p>
                <p className="text-xs text-muted-foreground">
                  {subjectLabels[grant.subject.type]}
                </p>
              </div>
              <Select
                disabled={!canManage || mutation.isPending}
                value={presetFor(grant.actions, policy.resource)}
                onValueChange={(preset) => {
                  const choice = Object.entries(presets).find(
                    ([key]) => key === preset,
                  )?.[1];
                  if (choice)
                    update(index, { ...grant, actions: [...choice.actions] });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="h-auto min-h-8 w-36 shrink-0 border-transparent text-left shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted [&_[data-slot=select-value]]:line-clamp-none [&_[data-slot=select-value]]:whitespace-normal"
                  aria-label={`Permission for ${grant.name}`}
                >
                  <SelectValue>
                    {actionSummary(grant.actions, policy.resource)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(presets).map(([key, preset]) => (
                    <SelectItem
                      key={key}
                      value={key}
                      disabled={preset.actions.some(
                        (action) => !policy.effectiveActions.includes(action),
                      )}
                    >
                      <span className="block font-medium">{preset.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {presetDescription(key, policy.resource)}
                      </span>
                    </SelectItem>
                  ))}
                  {presetFor(grant.actions, policy.resource) === "custom" && (
                    <SelectItem value="custom" disabled>
                      {actionSummary(grant.actions, policy.resource)}
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
              className="flex items-center gap-3 py-1.5 text-muted-foreground"
            >
              <SubjectIcon type={grant.type} />
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
                <p className="break-words text-sm font-medium">{grant.name}</p>
                <span className="text-xs">{subjectLabels[grant.type]}</span>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-7 gap-1 px-1 text-xs font-normal text-muted-foreground"
                      aria-label={`Why ${grant.name} has access: ${grant.via}`}
                    >
                      <span>{grant.via}</span>
                      <Info className="size-3" aria-hidden="true" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="w-72 max-w-[calc(100vw-2rem)] px-3 py-2 text-xs leading-relaxed"
                    aria-label={`Access source for ${grant.name}`}
                  >
                    <p>
                      <span>{grant.explanation}</span>
                      {grant.source !== "legacy" && (
                        <span>
                          {" Edit in "}
                          <Button
                            type="button"
                            variant="link"
                            className="h-auto p-0 text-xs underline underline-offset-2"
                            onClick={() => setAllPermissionsOpen(true)}
                          >
                            permissions for all{" "}
                            {resourcePluralNames[policy.resource]}
                          </Button>
                          .
                        </span>
                      )}
                    </p>
                  </PopoverContent>
                </Popover>
              </div>
              <p className="w-36 shrink-0 border border-transparent px-3 text-sm text-foreground">
                {actionSummary(grant.actions, policy.resource)}
              </p>
              <span className="size-8 shrink-0" />
            </div>
          ))}
        </div>

        {footerContainer === undefined
          ? actions
          : footerContainer && createPortal(actions, footerContainer)}
        {allPermissionsOpen && (
          <ResourcePermissionsDialog
            resource={policy.resource}
            open={allPermissionsOpen}
            onOpenChange={setAllPermissionsOpen}
          />
        )}
      </Container>
      {canManage && addOpen && (
        <AccessPicker
          open={addOpen}
          onOpenChange={setAccessOpen}
          inline={
            dialog
              ? {
                  footerContainer: dialog.footerContainer,
                  onDirtyChange: dialog.setAccessDirty,
                }
              : undefined
          }
          resource={policy.resource}
          scope={policy.scope}
          context={title ?? policy.name}
          existingSubjects={fields.map((entry) => entry.subject)}
          presets={Object.entries(presets).map(([value, preset]) => ({
            value,
            label: preset.label,
            description: presetDescription(value, policy.resource),
            actions: [...preset.actions],
            disabled: preset.actions.some(
              (action) => !policy.effectiveActions.includes(action),
            ),
          }))}
          onAdd={(grants) => append(grants)}
        />
      )}
    </>
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
export function presetFor(
  actions: ResourcePermissionAction[],
  resource?: ScopedResource,
) {
  return (
    Object.entries(presetsFor(resource)).find(
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
function actionSummary(
  actions: ResourcePermissionAction[],
  resource: ScopedResource,
) {
  const preset = presetFor(actions, resource);
  const choice = Object.entries(presetsFor(resource)).find(
    ([key]) => key === preset,
  )?.[1];
  if (choice) return choice.label;
  return actions.map((action) => actionLabels[action]).join(", ");
}

function presetsFor(
  resource?: ScopedResource,
): Record<
  string,
  { label: string; actions: readonly ResourcePermissionAction[] }
> {
  if (resource === "log" || resource === "auditLog") {
    return {
      view: resourcePermissionPresets.view,
      manage: {
        label: "Full access",
        actions: ["read", "manage-permissions"] as const,
      },
    };
  }
  return resourcePermissionPresets;
}

export function presetDescription(preset: string, resource: ScopedResource) {
  return preset === "manage" && (resource === "log" || resource === "auditLog")
    ? "View logs and manage who can access them"
    : presetDescriptions[preset as keyof typeof resourcePermissionPresets];
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

const resourcePluralNames: Record<ScopedResource, string> = {
  agent: "agents",
  skill: "skills",
  app: "apps",
  llmModel: "models",
  mcpGateway: "MCP gateways",
  mcpRegistry: "MCP registry entries",
  project: "projects",
  plugin: "plugins",
  knowledgeBase: "knowledge bases",
  knowledgeConnector: "connectors",
  knowledgeFile: "files",
  llmVirtualKey: "virtual keys",
  llmProviderApiKey: "provider keys",
  environment: "environments",
  scheduledTask: "scheduled tasks",
  log: "LLM and MCP logs",
  auditLog: "audit logs",
  serviceAccount: "service accounts",
};

const ResourcePermissionsDialogContext = createContext<{
  footerContainer: HTMLElement | null;
  setAccessOpen: (open: boolean) => void;
  setAccessDirty: (dirty: boolean) => void;
} | null>(null);
