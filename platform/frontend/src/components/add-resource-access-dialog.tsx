// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type PermissionSubject,
  type ResourcePermissionAction,
  type ScopedResource,
  TEAM_RESOURCE_SCOPE,
} from "@archestra/shared";
import {
  ArrowLeft,
  Bot,
  Building2,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { QueryLoadError } from "@/components/query-load-error";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  type PermissionRecipient,
  usePermissionRecipients,
} from "@/lib/resource-permissions.query";

export function AddResourceAccessDialog(props: Props) {
  return props.open ? <AccessDialogContent {...props} /> : null;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: ScopedResource;
  scope: string;
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

function AccessDialogContent({
  open,
  onOpenChange,
  resource,
  scope,
  existingSubjects,
  context,
  presets,
  onAdd,
}: Props) {
  const [category, setCategory] = useState<PermissionSubject["type"] | null>(
    null,
  );
  const fieldId = useId();
  const categoryTitleRef = useRef<HTMLHeadingElement>(null);
  const firstCategoryRef = useRef<HTMLButtonElement>(null);
  const form = useForm<{
    search: string;
    recipients: PermissionRecipient[];
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
  const activePreset = presets.find(
    (preset) => preset.value === permission && !preset.disabled,
  );
  const label =
    categories.find((item) => item.type === category)?.label ??
    "Everyone in the organization";

  useEffect(() => {
    if (category === null) firstCategoryRef.current?.focus();
    else if (category === "organization") categoryTitleRef.current?.focus();
    else form.setFocus("search");
  }, [category, form]);

  function chooseCategory(next: PermissionSubject["type"]) {
    form.setValue("search", "");
    setCategory(next);
  }

  function toggleRecipient(recipient: PermissionRecipient) {
    const key = subjectKey(recipient.subject);
    form.setValue(
      "recipients",
      selected.some((entry) => subjectKey(entry.subject) === key)
        ? selected.filter((entry) => subjectKey(entry.subject) !== key)
        : [...selected, recipient],
    );
  }

  function addAccess() {
    if (!activePreset || selected.length === 0) return;
    onAdd(
      selected.map((recipient) => ({
        ...recipient,
        actions: [...activePreset.actions],
      })),
    );
    onOpenChange(false);
  }

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={context ? `Add access · ${context}` : "Add access"}
      description="Choose who should have access. Changes take effect after you save permissions on the page."
      isDirty={selected.length > 0}
      bodyClassName="space-y-5"
      footer={
        <>
          <DialogCancelButton />
          {category !== null && (
            <Button
              type="button"
              onClick={addAccess}
              disabled={
                !activePreset ||
                selected.length === 0 ||
                recipients.isError ||
                recipients.isLoading
              }
            >
              <span>Add access</span>
            </Button>
          )}
        </>
      }
    >
      {category === null ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {categories
              .filter(
                (item) =>
                  scope !== TEAM_RESOURCE_SCOPE ||
                  item.type !== "serviceAccount",
              )
              .map(
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
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Back to recipient types"
              onClick={() => setCategory(null)}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <h3
              ref={categoryTitleRef}
              tabIndex={-1}
              className="text-sm font-medium"
            >
              {label}
            </h3>
          </div>
          {category !== "organization" && (
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-search`}>
                Search {label.toLowerCase()}
              </Label>
              <Input
                id={`${fieldId}-search`}
                placeholder={`Search ${label.toLowerCase()}…`}
                {...form.register("search")}
              />
            </div>
          )}
          {recipients.isError ? (
            <QueryLoadError
              title="Could not load recipients"
              onRetry={() => void recipients.refetch()}
              className="min-h-40"
            />
          ) : recipients.isLoading || query !== search ? (
            <output className="block py-6 text-center text-sm text-muted-foreground">
              <span>Loading recipients…</span>
            </output>
          ) : available.length === 0 ? (
            <output className="block py-6 text-center text-sm text-muted-foreground">
              <span>
                {search
                  ? "No matching recipients without direct access."
                  : "No recipients available to add."}
              </span>
            </output>
          ) : (
            <fieldset className="max-h-56 overflow-y-auto">
              <legend className="sr-only">Choose recipients</legend>
              <div className="divide-y">
                {available.map((recipient) => {
                  const key = subjectKey(recipient.subject);
                  const id = `${fieldId}-${key}`;
                  return (
                    <Label
                      key={key}
                      htmlFor={id}
                      className="flex cursor-pointer items-center gap-3 px-1 py-3 font-normal"
                    >
                      <Checkbox
                        id={id}
                        checked={selected.some(
                          (entry) => subjectKey(entry.subject) === key,
                        )}
                        onCheckedChange={() => toggleRecipient(recipient)}
                      />
                      <span className="min-w-0 break-words">
                        {recipient.name}
                      </span>
                    </Label>
                  );
                })}
              </div>
            </fieldset>
          )}
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
        </div>
      )}
      {selected.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            <span>{selected.length} selected</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {selected.map((recipient) => (
              <Badge
                key={subjectKey(recipient.subject)}
                variant="secondary"
                className="gap-1 font-normal"
              >
                <span>{recipient.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5"
                  aria-label={`Remove ${recipient.name} from selection`}
                  onClick={() => toggleRecipient(recipient)}
                >
                  <X className="size-3" />
                </Button>
              </Badge>
            ))}
          </div>
        </div>
      )}
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
