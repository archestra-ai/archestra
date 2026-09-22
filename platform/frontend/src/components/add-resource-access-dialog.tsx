// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type {
  PermissionSubject,
  ResourcePermissionAction,
  ScopedResource,
} from "@archestra/shared";
import {
  Bot,
  Building2,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useForm } from "react-hook-form";
import {
  PermissionRecipientIdentity,
  PermissionRecipientSelect,
} from "@/components/permission-recipient-select";
import { QueryLoadError } from "@/components/query-load-error";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  type PermissionRecipient,
  usePermissionRecipients,
} from "@/lib/resource-permissions.query";

export function AddResourceAccessDialog(props: Props) {
  return props.open ? <ResourceAccessPicker {...props} /> : null;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: ScopedResource;
  /** Omit when selections will be submitted with a new resource. */
  scope?: string;
  context?: string;
  existingSubjects: PermissionSubject[];
  presets: Array<{
    value: string;
    label: string;
    description: string;
    actions: ResourcePermissionAction[];
    disabled: boolean;
  }>;
  onAdd: (
    grants: Array<
      PermissionRecipient & { actions: ResourcePermissionAction[] }
    >,
  ) => void;
};

export function ResourceAccessPicker({
  open,
  onOpenChange,
  resource,
  scope,
  existingSubjects,
  context,
  presets,
  onAdd,
  inline,
}: Props & {
  inline?: {
    footerContainer: HTMLElement | null;
    onDirtyChange: (dirty: boolean) => void;
  };
}) {
  const [category, setCategory] = useState<PermissionSubject["type"] | null>(
    null,
  );
  const fieldId = useId();
  const categoryTitleRef = useRef<HTMLHeadingElement>(null);
  const firstCategoryRef = useRef<HTMLButtonElement>(null);
  const form = useForm<{
    search: string;
    recipients: Array<PermissionRecipient & { permission: string }>;
    permission: string;
  }>({
    defaultValues: {
      search: "",
      recipients: [],
      permission:
        presets.find((preset) => preset.value === "view" && !preset.disabled)
          ?.value ??
        presets.find((preset) => !preset.disabled)?.value ??
        "",
    },
  });
  const selected = form.watch("recipients");
  const permission = form.watch("permission");
  const search = form.watch("search");
  const query = useDebouncedValue(search, 250);
  const recipients = usePermissionRecipients({
    resource,
    scope,
    query,
    enabled: open && category !== null,
  });
  const existing = new Set(existingSubjects.map(subjectKey));
  const available = (recipients.data ?? []).filter(
    (recipient) =>
      recipient.subject.type === category &&
      !existing.has(subjectKey(recipient.subject)),
  );
  // Organization is a complete audience choice; other types need selections.
  const audience =
    category === "organization"
      ? available.map((recipient) => ({ ...recipient, permission }))
      : selected;
  const activePreset = presets.find(
    (preset) => preset.value === permission && !preset.disabled,
  );
  const label =
    categories.find((item) => item.type === category)?.label ??
    "Everyone in the organization";

  useEffect(() => {
    if (category === null) firstCategoryRef.current?.focus();
    else categoryTitleRef.current?.focus();
  }, [category]);

  const dirty = selected.length > 0 || category === "organization";
  const reportDirty = inline?.onDirtyChange;
  useEffect(() => {
    reportDirty?.(dirty);
    return () => reportDirty?.(false);
  }, [dirty, reportDirty]);

  function chooseCategory(next: PermissionSubject["type"]) {
    form.setValue("search", "");
    setCategory(next);
  }

  function addRecipient(recipient: PermissionRecipient) {
    if (
      !activePreset ||
      selected.some(
        (entry) => subjectKey(entry.subject) === subjectKey(recipient.subject),
      )
    )
      return;
    form.setValue("recipients", [
      ...selected,
      { ...recipient, permission: activePreset.value },
    ]);
  }

  function addAccess() {
    if (audience.length === 0) return;
    const additions = audience.flatMap(
      ({ permission: selectedPermission, ...recipient }) => {
        const preset = presets.find(
          (entry) => entry.value === selectedPermission && !entry.disabled,
        );
        return preset ? [{ ...recipient, actions: [...preset.actions] }] : [];
      },
    );
    if (additions.length !== audience.length) return;
    onAdd(additions);
    onOpenChange(false);
  }

  const footer = (
    <>
      {category === null ? (
        inline ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            <span>Back</span>
          </Button>
        ) : (
          <DialogCancelButton />
        )
      ) : (
        <Button
          type="button"
          variant="outline"
          aria-label="Back to recipient types"
          onClick={() => setCategory(null)}
        >
          <span>Back</span>
        </Button>
      )}
      {(category !== null || selected.length > 0) && (
        <Button
          type="button"
          onClick={addAccess}
          disabled={
            !activePreset ||
            audience.length === 0 ||
            recipients.isError ||
            recipients.isLoading
          }
        >
          <span>Add access</span>
        </Button>
      )}
    </>
  );
  const body = (
    <div className="space-y-5">
      {category === null ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {categories.map(
              ({ type, label: categoryLabel, description, icon: Icon }) => (
                <Button
                  key={type}
                  ref={type === "user" ? firstCategoryRef : undefined}
                  type="button"
                  variant="outline"
                  className="h-auto flex-col gap-3 whitespace-normal p-5 text-center"
                  onClick={() => chooseCategory(type)}
                >
                  <Icon className="size-6 text-muted-foreground" />
                  <span className="space-y-1">
                    <span className="block font-medium">{categoryLabel}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {description}
                    </span>
                  </span>
                </Button>
              ),
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start gap-3 whitespace-normal px-3 py-3"
            disabled={existing.has(
              subjectKey({ type: "organization", id: "*" }),
            )}
            onClick={() => chooseCategory("organization")}
          >
            <Building2 className="size-5 text-muted-foreground" />
            <span>Everyone in the organization</span>
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          <h3
            ref={categoryTitleRef}
            tabIndex={-1}
            className="text-sm font-medium"
          >
            {label}
          </h3>
          {recipients.isError ? (
            <QueryLoadError
              title="Could not load recipients"
              onRetry={() => void recipients.refetch()}
              className="min-h-40"
            />
          ) : category !== "organization" ? (
            <PermissionRecipientSelect
              key={category}
              label={label}
              recipients={available.filter(
                (recipient) =>
                  !selected.some(
                    (entry) =>
                      subjectKey(entry.subject) ===
                      subjectKey(recipient.subject),
                  ),
              )}
              loading={recipients.isLoading || query !== search}
              onSearchChange={(value) => form.setValue("search", value)}
              onSelect={addRecipient}
            />
          ) : recipients.isLoading || query !== search ? (
            <output className="block py-6 text-center text-sm text-muted-foreground">
              <span>Loading recipients…</span>
            </output>
          ) : available.length === 0 ? (
            <output className="block py-6 text-center text-sm text-muted-foreground">
              <span>No recipients available to add.</span>
            </output>
          ) : null}
          {category === "organization" && (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Permission</legend>
              <RadioGroup
                value={permission}
                onValueChange={(value) => form.setValue("permission", value)}
                aria-label="Permission"
              >
                {presets.map((preset) => (
                  <Label
                    key={preset.value}
                    htmlFor={`${fieldId}-permission-${preset.value}`}
                    className="items-start gap-3 py-1 font-normal"
                  >
                    <RadioGroupItem
                      id={`${fieldId}-permission-${preset.value}`}
                      value={preset.value}
                      disabled={preset.disabled}
                      className="mt-0.5"
                    />
                    <span className="space-y-1">
                      <span className="block text-sm font-medium">
                        {preset.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {preset.description}
                      </span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
          )}
        </div>
      )}
      {category !== "organization" && selected.length > 0 && (
        <div className="divide-y border-y">
          {selected.map((recipient, index) => (
            <div
              key={subjectKey(recipient.subject)}
              className="flex items-center gap-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <PermissionRecipientIdentity recipient={recipient} />
              </div>
              <Select
                value={recipient.permission}
                onValueChange={(value) =>
                  form.setValue(
                    "recipients",
                    selected.map((entry, entryIndex) =>
                      entryIndex === index
                        ? { ...entry, permission: value }
                        : entry,
                    ),
                  )
                }
              >
                <SelectTrigger
                  size="sm"
                  className="w-32 shrink-0"
                  aria-label={`Permission for ${recipient.name}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((preset) => (
                    <SelectItem
                      key={preset.value}
                      value={preset.value}
                      disabled={preset.disabled}
                    >
                      <span>{preset.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${recipient.name} from selection`}
                onClick={() =>
                  form.setValue(
                    "recipients",
                    selected.filter((_, entryIndex) => entryIndex !== index),
                  )
                }
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
  if (inline) {
    return (
      <>
        {body}
        {inline.footerContainer &&
          createPortal(
            <div className="flex w-full justify-end gap-2">{footer}</div>,
            inline.footerContainer,
          )}
      </>
    );
  }
  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={context ? `Add access · ${context}` : "Add access"}
      description={
        scope === undefined
          ? "Choose who should have access when this resource is created. You can change permissions later."
          : "Choose who to add and set what each recipient can do."
      }
      isDirty={dirty}
      footer={footer}
    >
      {body}
    </StandardDialog>
  );
}

function subjectKey(subject: PermissionSubject) {
  return `${subject.type}:${subject.id}`;
}

const categories = [
  {
    type: "user",
    label: "People",
    description: "Choose individual members",
    icon: UserRound,
  },
  {
    type: "team",
    label: "Teams",
    description: "Include current and future members",
    icon: UsersRound,
  },
  {
    type: "role",
    label: "Roles",
    description: "Include everyone with a role",
    icon: ShieldCheck,
  },
  {
    type: "serviceAccount",
    label: "Service accounts",
    description: "Give automation access",
    icon: Bot,
  },
] satisfies Array<{
  type: PermissionSubject["type"];
  label: string;
  description: string;
  icon: typeof UserRound;
}>;
