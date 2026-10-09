// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  grantsAudience,
  ORGANIZATION_WIDE_RESOURCES,
  type PermissionSubject,
  type ResourcePermissionAction,
  type resourcePermissionPresets,
  resourcePermissionPresetsFor,
  type ScopedResource,
} from "@archestra/shared";
import { AlertCircle, AlertTriangle, Info, Loader2, X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useFieldArray, useForm } from "react-hook-form";
import { AccessAudienceHeader } from "@/components/audience-chip";
import { PermissionLevelSelect } from "@/components/permission-level-select";
import { PermissionsSettingsSection } from "@/components/permissions-settings-section";
import { QueryLoadError } from "@/components/query-load-error";
import {
  defaultAddedPreset,
  ResourceAccessAddField,
} from "@/components/resource-access-add-field";
import { getPermissionSafetyPreview } from "@/components/resource-permission-safety-preview";
import { StandardDialog } from "@/components/standard-dialog";
import { TabbedDialogFooterSlot } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useMakeOwner } from "@/components/use-make-owner";
import { WizardFooter } from "@/components/wizard-footer";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  type ResourcePermissions as Policy,
  useResourcePermissions,
  useUpdateResourcePermissions,
} from "@/lib/resource-permissions.query";

/**
 * The permissions block is a list of people and rules, not another field. It
 * sits between ordinary inputs on most forms, so it takes the same rule the
 * other sections use to separate itself from the fields above and below.
 */
/** Marks the viewer's own row in a grant list. */
export function YouPill() {
  return (
    <span className="self-center rounded-full border px-1.5 text-[11px] leading-4 text-muted-foreground">
      You
    </span>
  );
}

export function PermissionsPanel({
  children,
  embedded,
  standalone,
}: {
  children: ReactNode;
  embedded: boolean;
  /** The section fills its container, so it needs no space above it. */
  standalone?: boolean;
}) {
  if (!embedded) return <>{children}</>;
  if (standalone) return <section className="space-y-2">{children}</section>;
  return <section className="space-y-2 pt-2">{children}</section>;
}

export function ResourcePermissions({
  resource,
  scope,
  onDirtyChange,
  embedded = false,
  title,
  description,
  registerSave,
  standalone = false,
  layout = "default",
}: {
  resource: ScopedResource;
  scope: string;
  onDirtyChange?: (dirty: boolean) => void;
  embedded?: boolean;
  title?: string | null;
  description?: ReactNode;
  /**
   * Hands the host form a function that saves this policy. Providing it also
   * hides this section's own Save and Discard, because the host's footer
   * becomes the only place the edits are committed.
   */
  registerSave?: (save: (() => Promise<void>) | null) => void;
  /** The section is a pane of its own, so it draws no separating rule. */
  standalone?: boolean;
  layout?: "default" | "settings";
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
      registerSave={registerSave}
      standalone={standalone}
      layout={layout}
    />
  );
}

/** Shared by resource lists and the explanation of inherited access. */
export function ResourcePermissionsDialog({
  resource,
  scope = "*",
  title,
  description,
  lead,
  children,
  open,
  onOpenChange,
}: {
  resource: ScopedResource;
  scope?: string;
  title?: string;
  description?: string;
  /** Shown above the access list, such as the shared object's link. */
  lead?: ReactNode;
  children?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [isDirty, setIsDirty] = useState(false);
  const [footerContainer, setFooterContainer] =
    useState<HTMLFieldSetElement | null>(null);
  // A lead such as a share link renders before the list loads, so it would
  // take the open-time focus and show a ring. Start on its wrapper instead,
  // as the dialog does without a lead; Tab still reaches its controls.
  const leadRef = useRef<HTMLDivElement>(null);
  const noun = scopedResourceNouns[resource];
  return (
    <StandardDialog
      open={open}
      initialFocusRef={lead ? leadRef : undefined}
      onOpenChange={onOpenChange}
      title={title ?? `Permissions for all ${resourcePluralNames[resource]}`}
      description={
        description ??
        (scope !== "*"
          ? `Choose who can access this ${noun} and what they can do.`
          : `Applies to every ${noun}, including new ones.` +
            (ORGANIZATION_WIDE_RESOURCES.has(resource)
              ? ""
              : " Individual permissions can add access, but can’t take away access granted here."))
      }
      isDirty={isDirty}
      className="w-[calc(100%-2rem)] max-h-[90dvh] sm:max-w-3xl"
      headerClassName="text-left [&_[data-slot=dialog-title]]:pr-6 [&_[data-slot=dialog-title]]:leading-snug"
      // The list starts with its own header, which reads as a heading
      // already. A full body inset above it just pushes the list down.
      bodyClassName="pt-2"
      footer={
        <fieldset
          ref={setFooterContainer}
          aria-label="Permission actions"
          className="flex min-w-0 w-full justify-end"
        >
          {!isDirty && <DialogCancelButton>Done</DialogCancelButton>}
        </fieldset>
      }
    >
      <ResourcePermissionsDialogContext.Provider value={{ footerContainer }}>
        {lead && (
          <div ref={leadRef} tabIndex={-1} className="outline-none">
            {lead}
          </div>
        )}
        {open && (
          // The dialog's own title and description already say whose access
          // this is, so the editor contributes only the list.
          <ResourcePermissions
            resource={resource}
            scope={scope}
            embedded
            title={null}
            description={null}
            onDirtyChange={setIsDirty}
          />
        )}
        {children}
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
  registerSave,
  standalone = false,
  layout = "default",
}: {
  policy: Policy;
  refreshFailed: boolean;
  onRetry: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  embedded?: boolean;
  title?: string | null;
  description?: ReactNode;
  registerSave?: (save: (() => Promise<void>) | null) => void;
  standalone?: boolean;
  layout?: "default" | "settings";
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
  // A tabbed settings dialog lends its footer, so Save sits beside its Cancel.
  const shellFooter = useContext(TabbedDialogFooterSlot);
  const inShell = shellFooter !== undefined;
  const footerContainer = dialog?.footerContainer ?? shellFooter;
  const { data: canUpdateGlobal } = useHasPermissions({
    accessPolicies: ["update"],
  });
  const { data: session } = useSession();
  const canManage =
    policy.scope === "*"
      ? !!canUpdateGlobal
      : policy.effectiveActions.includes("manage-permissions");
  const presets = resourcePermissionPresetsFor(policy.resource);
  // A level is offered only when the viewer holds every action in it.
  const canGrant = (actions: readonly ResourcePermissionAction[]) =>
    actions.every((action) => policy.effectiveActions.includes(action));
  const levelOptions = Object.entries(presets).map(([value, preset]) => ({
    value,
    label: preset.label,
    description: presetDescription(value, policy.resource),
    actions: preset.actions,
    disabled: !canGrant(preset.actions),
  }));
  const mutation = useUpdateResourcePermissions(policy.resource, policy.scope);
  const changedElsewhere = dirty && policy.revision !== form.watch("revision");
  const safety = getPermissionSafetyPreview({
    policy,
    grants: form.watch("grants"),
  });
  const blocked = dirty && safety?.blocked === true;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const ownership = useMakeOwner({
    resource: policy.resource,
    scope: policy.scope,
    effectiveActions: policy.effectiveActions,
  });
  const [pendingOwner, setPendingOwner] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const reset = () =>
    form.reset({ revision: policy.revision, grants: policy.grants });
  const persist = (values: { revision: number; grants: Policy["grants"] }) => {
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
  };
  const submit = form.handleSubmit((values) => {
    if (blocked || changedElsewhere || refreshFailed) return;
    if (dirty && safety?.losesManagement) setConfirmOpen(true);
    else persist(values);
  });
  // A host form that submits this section along with its own fields needs to
  // flush the policy in its submit handler. Without it the section's edits
  // live only in this form and the host's save would drop them silently.
  const saveIfDirty = useCallback(async () => {
    if (!form.formState.isDirty) return;
    const values = form.getValues();
    const saved = await mutation.mutateAsync({
      revision: values.revision,
      grants: values.grants.map(({ subject, actions }) => ({
        subject,
        actions,
      })),
    });
    form.reset({ revision: saved.revision, grants: saved.grants });
  }, [form, mutation]);
  useEffect(() => {
    registerSave?.(saveIfDirty);
    return () => registerSave?.(null);
  }, [registerSave, saveIfDirty]);
  const draftGrants = form.watch("grants");
  // An object's own grants decide its audience. The organization-wide policy
  // has no audience of its own, so it shows no chip.
  const audience =
    policy.scope === "*" ? null : grantsAudience(draftGrants ?? []);
  const Container = embedded ? "div" : "form";
  const noun = scopedResourceNouns[policy.resource];
  const explanation =
    description === undefined
      ? `Applies to every ${scopedResourceNouns[policy.resource]}, including ones created later.`
      : description;
  const presetOptions = Object.entries(presets).map(([value, preset]) => ({
    value,
    actions: [...preset.actions],
    disabled: !canGrant(preset.actions),
  }));
  const addField = canManage ? (
    <ResourceAccessAddField
      resource={policy.resource}
      scope={policy.scope}
      existingSubjects={fields.map((entry) => entry.subject)}
      disabled={mutation.isPending || !policy.effectiveActions.includes("read")}
      onPick={(recipient) => {
        const preset = defaultAddedPreset(presetOptions);
        if (preset) append({ ...recipient, actions: preset.actions });
      }}
    />
  ) : null;
  // With a host form driving the save, this section contributes no actions of
  // its own. The host's footer already says there are unsaved changes.
  const actions =
    canManage && dirty && !registerSave ? (
      <div
        // A tabbed dialog hides its own buttons while this row owns its
        // footer, the way the all-permissions dialog swaps Done for it.
        data-section-actions=""
        className="flex w-full items-center justify-between gap-3 [&_button]:h-11 sm:[&_button]:h-8"
      >
        <span className="hidden text-xs text-muted-foreground sm:inline">
          Unsaved changes
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Discard changes"
            disabled={mutation.isPending}
            onClick={reset}
          >
            <span>Discard</span>
          </Button>
          <Button
            // The bar is portaled out of the form, so it cannot submit it.
            type="button"
            size="sm"
            aria-label="Save permissions"
            onClick={() => void submit()}
            disabled={
              mutation.isPending || changedElsewhere || refreshFailed || blocked
            }
          >
            <span>{mutation.isPending ? "Saving…" : "Save"}</span>
          </Button>
        </div>
      </div>
    ) : null;
  // A detail page's own tab saves through the same sticky footer as the
  // page's Settings tab: one "Save changes", shown while you can edit and
  // enabled once something changed.
  const pageFooter =
    !embedded && footerContainer === undefined && !dialog && !registerSave;
  const grantList = (
    <div className="divide-y divide-border/60 overflow-hidden rounded-lg border bg-card text-[13px]">
      {fields.length === 0 && (
        <p className="px-2.5 py-2.5 text-muted-foreground">
          Nobody has access yet.
        </p>
      )}
      {fields.map((grant, index) => {
        const isOwner =
          grant.subject.type === "user" && grant.subject.id === policy.ownerId;
        return (
          <div
            key={grant.id}
            data-testid={isOwner ? "owner-grant" : undefined}
            className="grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-2.5 py-2 sm:flex sm:gap-2 sm:py-0"
          >
            <div className="col-span-2 flex min-w-0 flex-1 flex-col items-start gap-x-2 sm:flex-row sm:flex-wrap sm:items-baseline">
              <p className="break-words font-medium">{grant.name}</p>
              <p className="text-xs text-muted-foreground">
                {subjectLabels[grant.subject.type]}
              </p>
              {isOwner && <OwnerPill />}
              {grant.subject.type === "user" &&
                grant.subject.id === session?.user.id && <YouPill />}
            </div>
            {isOwner ? (
              // The owner always keeps their grant: handing the object on is
              // "Make owner" on another person's row, not an edit of this one.
              <span className="px-2 pr-[3.25rem] text-muted-foreground sm:pr-11">
                {levelOptions.find(
                  (option) =>
                    option.value === presetFor(grant.actions, policy.resource),
                )?.label ?? actionSummary(grant.actions, policy.resource)}
              </span>
            ) : (
              <>
                <PermissionLevelSelect
                  disabled={!canManage || mutation.isPending}
                  value={presetFor(grant.actions, policy.resource)}
                  onValueChange={(preset) => {
                    const choice = Object.entries(presets).find(
                      ([key]) => key === preset,
                    )?.[1];
                    if (choice)
                      update(index, { ...grant, actions: [...choice.actions] });
                  }}
                  options={levelOptions}
                  ariaLabel={`Permission for ${grant.name}`}
                  title={actionDetail(grant.actions, policy.resource)}
                  valueLabel={
                    presetFor(grant.actions, policy.resource) === "custom"
                      ? actionSummary(grant.actions, policy.resource)
                      : undefined
                  }
                  extraOption={
                    presetFor(grant.actions, policy.resource) === "custom"
                      ? {
                          value: "custom",
                          label: actionSummary(grant.actions, policy.resource),
                        }
                      : undefined
                  }
                  inline
                  action={
                    grant.subject.type === "user" && ownership.available
                      ? {
                          label: "Make owner",
                          description: dirty
                            ? "Save your changes first."
                            : "Gets Full access. The current owner keeps Full access.",
                          disabled: dirty || ownership.isPending,
                          onSelect: () =>
                            setPendingOwner({
                              id: grant.subject.id,
                              name: grant.name,
                            }),
                        }
                      : undefined
                  }
                  className="h-11 min-h-11 text-[13px] sm:h-7 sm:min-h-7"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-11 shrink-0 text-muted-foreground sm:size-7"
                  disabled={!canManage || mutation.isPending}
                  aria-label={`Remove direct access for ${grant.name}`}
                  onClick={() => remove(index)}
                >
                  <X className="size-3.5" />
                </Button>
              </>
            )}
          </div>
        );
      })}
      {addField && <div className="p-1.5">{addField}</div>}
    </div>
  );
  const accessRows = (
    <>
      {grantList}
      {policy.scope !== "*" && (
        <InheritedAccessNote
          resource={policy.resource}
          grants={policy.inheritedGrants}
        />
      )}
    </>
  );
  return (
    <>
      <Container
        onSubmit={embedded ? undefined : submit}
        className={embedded && !dialog ? undefined : "space-y-3"}
      >
        <PermissionsPanel
          embedded={embedded && !dialog}
          standalone={standalone || inShell}
        >
          {!canManage && (
            <InlineNotice variant="info">
              <Info />
              <span className="font-medium">You can’t change permissions.</span>
              <InlineNoticeText>
                Ask someone with full access to let you change permissions.
              </InlineNoticeText>
            </InlineNotice>
          )}
          {layout !== "settings" && audience && (
            <AccessAudienceHeader audience={audience} />
          )}
          {layout !== "settings" && !audience && title !== null && (
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-semibold">
                {title ?? "Who has access"}
              </h2>
              {explanation && (
                <p className="max-w-prose text-xs text-muted-foreground">
                  {explanation}
                </p>
              )}
            </div>
          )}
          {refreshFailed && (
            <InlineNotice variant="error">
              <AlertCircle />
              <span className="font-medium">
                Could not refresh permissions.
              </span>
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

          {layout === "settings" ? (
            <PermissionsSettingsSection audience={audience}>
              {accessRows}
            </PermissionsSettingsSection>
          ) : (
            accessRows
          )}

          {canManage &&
            dirty &&
            safety &&
            (blocked ? (
              <InlineNotice variant="error">
                <AlertTriangle />
                <span className="font-medium">
                  Someone must be able to change permissions.
                </span>
                <InlineNoticeText>
                  These changes would leave no one able to change permissions.
                  Give another recipient full access before removing your own.
                </InlineNoticeText>
              </InlineNotice>
            ) : safety.losesManagement ? (
              <InlineNotice>
                <AlertTriangle />
                <span className="font-medium">
                  {safety.losesAccess
                    ? "You’ll lose access."
                    : "You won’t be able to change permissions."}
                </span>
                <InlineNoticeText>
                  <span>
                    {safety.losesAccess
                      ? "You won’t be able to view or use these resources. "
                      : "You can still view these resources, but you won’t be able to change who has access. "}
                    {safety.losesAccess
                      ? `Ask ${safety.recovery} to give you access again.`
                      : `To change permissions again, ask ${safety.recovery}.`}
                  </span>
                </InlineNoticeText>
              </InlineNotice>
            ) : null)}
          {pageFooter
            ? canManage && (
                <WizardFooter className="border-t-0 sm:justify-end">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      !dirty ||
                      mutation.isPending ||
                      changedElsewhere ||
                      refreshFailed ||
                      blocked
                    }
                  >
                    {mutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Saving...</span>
                      </>
                    ) : (
                      <span>Save changes</span>
                    )}
                  </Button>
                </WizardFooter>
              )
            : footerContainer === undefined
              ? actions && <div className="pt-1">{actions}</div>
              : footerContainer && createPortal(actions, footerContainer)}
        </PermissionsPanel>
      </Container>
      <StandardDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        size="small"
        className="w-[calc(100%-2rem)] max-h-[90dvh]"
        headerClassName="text-left [&_[data-slot=dialog-title]]:pr-6 [&_[data-slot=dialog-title]]:leading-snug"
        footerClassName="[&_button]:min-h-11 sm:[&_button]:min-h-9"
        title={
          safety?.losesAccess
            ? "Give up your access?"
            : "Give up the ability to change permissions?"
        }
        description={
          safety?.losesAccess
            ? `You’re about to give up access for ${policy.scope === "*" ? `all ${resourcePluralNames[policy.resource]}` : `this ${noun}`}.`
            : `You can still view ${policy.scope === "*" ? `all ${resourcePluralNames[policy.resource]}` : `this ${noun}`}, but you won’t be able to change who has access.`
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Keep editing
            </Button>
            <Button
              disabled={
                mutation.isPending ||
                changedElsewhere ||
                refreshFailed ||
                blocked
              }
              onClick={() => {
                setConfirmOpen(false);
                void form.handleSubmit(persist)();
              }}
            >
              {safety?.losesAccess
                ? "Save and give up access"
                : "Save changes anyway"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          You won’t be able to undo this yourself.
          <span>
            {safety?.losesAccess
              ? ` Ask ${safety?.recovery} to give you access again.`
              : ` To change permissions again, ask ${safety?.recovery}.`}
          </span>
        </p>
      </StandardDialog>
      <StandardDialog
        open={pendingOwner !== null}
        onOpenChange={(open) => {
          if (!open) setPendingOwner(null);
        }}
        size="small"
        className="w-[calc(100%-2rem)] max-h-[90dvh]"
        headerClassName="text-left [&_[data-slot=dialog-title]]:pr-6 [&_[data-slot=dialog-title]]:leading-snug"
        footerClassName="[&_button]:min-h-11 sm:[&_button]:min-h-9"
        title={`Make ${pendingOwner?.name ?? ""} the owner?`}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingOwner(null)}>
              Cancel
            </Button>
            <Button
              disabled={ownership.isPending}
              onClick={() => {
                if (!pendingOwner) return;
                void ownership
                  .makeOwner(pendingOwner.id)
                  .then(() => setPendingOwner(null))
                  // The mutation already reported the failure.
                  .catch(() => {});
              }}
            >
              {ownership.isPending ? "Saving…" : "Make owner"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          {pendingOwner?.name} becomes the owner and gets Full access. The
          current owner keeps Full access. Other grants do not change.
        </p>
      </StandardDialog>
    </>
  );
}

/** Marks the owner's row in a grant list. */
function OwnerPill() {
  return (
    <span className="self-center rounded-full bg-primary px-1.5 text-[11px] leading-4 font-medium text-primary-foreground">
      Owner
    </span>
  );
}

/**
 * Access every object of the type gives anyway, as plain muted text under the
 * grant list: "Admin and Platform Admin roles have Full access to every agent."
 */
export function InheritedAccessNote({
  resource,
  grants,
}: {
  resource: ScopedResource;
  grants: ReadonlyArray<{
    name: string;
    subject: PermissionSubject;
    actions: ResourcePermissionAction[];
  }>;
}) {
  if (grants.length === 0) return null;
  const byLevel = new Map<string, typeof grants>();
  for (const grant of grants) {
    const level = actionSummary(grant.actions, resource);
    byLevel.set(level, [...(byLevel.get(level) ?? []), grant]);
  }
  const noun = scopedResourceNouns[resource];
  const sentences = [...byLevel].map(([level, holders]) => {
    const names = joinNames(holders.map((holder) => holder.name));
    const allRoles = holders.every((holder) => holder.subject.type === "role");
    const who = allRoles
      ? `${names} ${holders.length > 1 ? "roles have" : "role has"}`
      : `${names} ${holders.length > 1 ? "have" : "has"}`;
    return `${who} ${level} to every ${noun}.`;
  });
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid="inherited-access-note"
    >
      {sentences.join(" ")}
    </p>
  );
}

/** @public - shared with initial-resource-permissions.tsx */
export function presetFor(
  actions: ResourcePermissionAction[],
  resource?: ScopedResource,
) {
  return (
    Object.entries(resourcePermissionPresetsFor(resource)).find(
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
export function actionSummary(
  actions: ResourcePermissionAction[],
  resource: ScopedResource,
) {
  const preset = presetFor(actions, resource);
  const choice = Object.entries(resourcePermissionPresetsFor(resource)).find(
    ([key]) => key === preset,
  )?.[1];
  if (choice) return choice.label;
  // A set that matches no preset gets one short word. Spelling out every
  // action here wrapped to three lines and pushed the row apart.
  return "Custom";
}

/** The full action list, for a tooltip beside the short "Custom" label. */
export function actionDetail(
  actions: ResourcePermissionAction[],
  resource: ScopedResource,
) {
  if (presetFor(actions, resource) !== "custom") return undefined;
  return actions.map((action) => actionLabels[action]).join(", ");
}

export function presetDescription(preset: string, resource: ScopedResource) {
  if (resource === "mcpOauthClient" || resource === "llmOauthClient") {
    // Nothing is used "through" a registration, so the edit level has no use.
    if (preset === "edit") return "View and edit the client, rotate its secret";
    if (preset === "manage")
      return "Also delete the client and manage permissions";
  }
  if (preset === "deploy" && resource === "mcpRegistry")
    return "Also view and change how the server is deployed";
  if (
    preset === "manage" &&
    (resource === "conversation" || resource === "agentRun")
  )
    return "View the session and manage who can access it";
  return preset === "manage" && (resource === "log" || resource === "auditLog")
    ? "View logs and manage who can access them"
    : presetDescriptions[preset as keyof typeof resourcePermissionPresets];
}
/** Singular, for sentences. `resourceLabels` is plural and reads as "every agents". */
export const scopedResourceNouns: Record<ScopedResource, string> = {
  conversation: "chat session",
  agentRun: "runtime session",
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
  externalAgent: "external agent",
  mcpOauthClient: "OAuth client",
  llmOauthClient: "OAuth client",
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
  "configure-deployment-spec": "Configure deployment spec",
};

export const resourcePluralNames: Record<ScopedResource, string> = {
  conversation: "chat sessions",
  agentRun: "runtime sessions",
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
  externalAgent: "external agents",
  mcpOauthClient: "MCP OAuth clients",
  llmOauthClient: "LLM OAuth clients",
  environment: "environments",
  scheduledTask: "scheduled tasks",
  log: "LLM and MCP logs",
  auditLog: "audit logs",
  serviceAccount: "service accounts",
};

const ResourcePermissionsDialogContext = createContext<{
  footerContainer: HTMLElement | null;
} | null>(null);

function joinNames(names: string[]) {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
