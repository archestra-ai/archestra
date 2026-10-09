// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { PermissionSubject, ScopedResource } from "@archestra/shared";
import { Plus, Search } from "lucide-react";
import { useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useListboxNavigation } from "@/lib/hooks/use-listbox-navigation";
import {
  groupPermissionRecipients,
  permissionRecipientLabel,
} from "@/lib/permission-recipients";
import {
  type PermissionRecipient,
  usePermissionRecipients,
} from "@/lib/resource-permissions.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * The one way to give someone access: a searchable field at the foot of the
 * grant list. Picking a recipient adds a draft grant straight away, at a
 * default level the row's own select can change, so there is no second step
 * to confirm.
 */
export function ResourceAccessAddField({
  resource,
  scope,
  existingSubjects,
  disabled = false,
  onPick,
}: {
  resource: ScopedResource;
  /** Omit when the grants will be submitted with a new resource. */
  scope?: string;
  /** Recipients that already hold a direct grant, left out of the results. */
  existingSubjects: PermissionSubject[];
  disabled?: boolean;
  onPick: (recipient: PermissionRecipient) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search, 250);
  const recipients = usePermissionRecipients({
    resource,
    scope,
    query,
    enabled: open,
  });
  const existing = new Set(existingSubjects.map(subjectKey));
  const available = (recipients.data ?? []).filter(
    (recipient) => !existing.has(subjectKey(recipient.subject)),
  );
  const groups = groupPermissionRecipients(available);
  const searching = recipients.isLoading || query !== search;
  const options = searching ? [] : groups.flatMap((group) => group.recipients);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };
  const pick = (key: string) => {
    const recipient = options.find(
      (entry) => subjectKey(entry.subject) === key,
    );
    if (!recipient) return;
    onPick(recipient);
    changeOpen(false);
  };
  const navigation = useListboxNavigation({
    open,
    onOpenChange: changeOpen,
    values: options.map((recipient) => subjectKey(recipient.subject)),
    onSelect: pick,
  });

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Add access"
          disabled={disabled}
          onKeyDown={navigation.onTriggerKeyDown}
          // Dashed while it waits, solid while the picker is open.
          className={cn(
            "h-11 w-full justify-start gap-2 rounded-md bg-card sm:h-[34px] px-2.5 text-[13px] font-normal text-muted-foreground shadow-none hover:bg-muted dark:bg-card",
            open ? "border-primary" : "border-dashed",
          )}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">
            Add access: everyone, a role, a team, a person or a service account…
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] min-w-72 overflow-hidden p-0"
      >
        <div className="flex items-center border-b px-3 py-2">
          <Search
            className="mr-2 size-4 shrink-0 opacity-50"
            aria-hidden="true"
          />
          <input
            {...navigation.inputProps}
            aria-label="Search recipients"
            placeholder="Search by name or email…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="flex w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {recipients.isError ? (
          <QueryLoadError
            title="Could not load recipients"
            onRetry={() => void recipients.refetch()}
            className="min-h-40"
          />
        ) : (
          <div
            {...navigation.listboxProps}
            role="listbox"
            aria-label="Recipients"
            className="max-h-[min(320px,calc(var(--radix-popover-content-available-height)-3rem))] overflow-y-auto p-1"
            onWheelCapture={(event) => event.stopPropagation()}
          >
            {searching ? (
              <output className="block px-4 py-6 text-center text-sm text-muted-foreground">
                <span>Searching…</span>
              </output>
            ) : groups.length === 0 ? (
              <output className="block px-4 py-6 text-center text-sm text-muted-foreground">
                <span>
                  {search
                    ? "No matching recipients available to add."
                    : "No recipients available to add."}
                </span>
              </output>
            ) : (
              groups.map((group) => (
                // biome-ignore lint/a11y/useSemanticElements: a listbox groups options with role="group", not a fieldset
                <div
                  key={group.label}
                  role="group"
                  aria-label={group.label}
                  className="py-1"
                >
                  <div
                    aria-hidden="true"
                    className="px-2 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    {group.label}
                  </div>
                  {group.recipients.map((recipient) => {
                    const key = subjectKey(recipient.subject);
                    const label = permissionRecipientLabel(recipient);
                    return (
                      <UnstyledButton
                        key={key}
                        {...navigation.getOptionProps(key)}
                        role="option"
                        aria-selected={false}
                        aria-label={label}
                        onClick={() => pick(key)}
                        className={cn(
                          "flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground",
                          navigation.activeValue === key &&
                            "bg-accent text-accent-foreground",
                        )}
                      >
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="truncate font-medium">{label}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {recipientNote(recipient)}
                          </span>
                        </span>
                      </UnstyledButton>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The preset a picked recipient starts at: "use" when the viewer may grant
 * it, otherwise the broadest level they may grant short of handing over
 * permission management, which a new recipient never gets by default. A
 * shared chat session, which has no "use", starts at view, not at manage.
 */
export function defaultAddedPreset<
  T extends { value: string; actions: readonly string[]; disabled: boolean },
>(presets: T[]): T | undefined {
  const allowed = presets.filter((preset) => !preset.disabled);
  return (
    allowed.find((preset) => preset.value === "use") ??
    allowed
      .filter((preset) => !preset.actions.includes("manage-permissions"))
      .at(-1) ??
    allowed[0]
  );
}

/** One short muted note beside a recipient's name in the picker. */
function recipientNote(recipient: PermissionRecipient) {
  if (recipient.subject.type === "organization")
    return "current and future members";
  if (recipient.subject.type === "role") return "role";
  return recipient.email ?? "";
}

function subjectKey(subject: PermissionSubject) {
  return `${subject.type}:${subject.id}`;
}
