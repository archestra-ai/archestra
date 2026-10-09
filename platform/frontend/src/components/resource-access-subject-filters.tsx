// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type PermissionSubject,
  parsePermissionSubjectKey,
  permissionSubjectKey,
  type ScopedResource,
} from "@archestra/shared";
import { Check, ChevronDown, Search, Share2, UserRound } from "lucide-react";
import { type ReactNode, useState } from "react";
import { filterControlClass } from "@/components/filter-bar";
import { PermissionRecipientIdentity } from "@/components/permission-recipient-select";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useSession } from "@/lib/auth/auth.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
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
 * "Shared with": keep objects whose own grants reach any picked recipient —
 * everyone in the organization, a role, a team, a person or a service
 * account. The value is a list of `permissionSubjectKey` tokens.
 */
export function ResourceSharedWithFilter({
  resource,
  value,
  onChange,
  footer,
}: {
  resource: ScopedResource;
  value: string[];
  /** Receives the new selection; an empty list clears the filter. */
  onChange: (value: string[]) => void;
  footer?: ReactNode;
}) {
  return (
    <SubjectFilter
      label="Shared with"
      icon={<Share2 className="size-4" aria-hidden="true" />}
      resource={resource}
      value={value}
      onChange={onChange}
      footer={footer}
      searchPlaceholder="Search everyone, roles, teams, people, service accounts"
      listLabel="Recipients"
      peopleOnly={false}
    />
  );
}

/** "Owner": keep objects authored by any picked person. The value is user ids. */
export function ResourceOwnerFilter({
  resource,
  value,
  onChange,
  footer,
}: {
  resource: ScopedResource;
  value: string[];
  /** Receives the new selection; an empty list clears the filter. */
  onChange: (value: string[]) => void;
  footer?: ReactNode;
}) {
  return (
    <SubjectFilter
      label="Owner"
      icon={<UserRound className="size-4" aria-hidden="true" />}
      resource={resource}
      value={value}
      onChange={onChange}
      footer={footer}
      searchPlaceholder="Search people"
      listLabel="Owners"
      peopleOnly
    />
  );
}

// ===

/** A picker option: its value in the filter, how it reads, and its identity row. */
type SubjectOption = {
  value: string;
  label: string;
  recipient: PermissionRecipient;
};

function SubjectFilter({
  label,
  icon,
  value,
  footer,
  ...pickerProps
}: {
  label: string;
  icon: ReactNode;
  value: string[];
  footer?: ReactNode;
} & Omit<SubjectPickerProps, "value" | "known" | "onSeen">) {
  const [open, setOpen] = useState(false);
  // Labels of every option picked so far, so a picked recipient keeps its
  // name after a new search drops it from the results. Kept here, outside the
  // popover body, so it survives the popover closing.
  const [known, setKnown] = useState<Map<string, SubjectOption>>(new Map());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Filter by ${label.toLowerCase()}`}
          className={filterControlClass({
            active: value.length > 0,
            className: "shrink-0 whitespace-nowrap",
          })}
        >
          {icon}
          <span>{label}</span>
          {value.length > 0 && (
            <Badge
              variant="secondary"
              className="h-4 min-w-4 rounded-full px-1 text-[10px] tabular-nums"
            >
              {value.length}
            </Badge>
          )}
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))] overflow-hidden p-0"
      >
        <SubjectPicker
          {...pickerProps}
          value={value}
          known={known}
          onSeen={(option) =>
            setKnown((current) => new Map(current).set(option.value, option))
          }
        />
        {footer && <div className="border-t px-2 py-1.5">{footer}</div>}
      </PopoverContent>
    </Popover>
  );
}

type SubjectPickerProps = {
  resource: ScopedResource;
  value: string[];
  onChange: (value: string[]) => void;
  searchPlaceholder: string;
  listLabel: string;
  /** Owner filter: people only, values are user ids, and "Me" comes first. */
  peopleOnly: boolean;
  known: Map<string, SubjectOption>;
  onSeen: (option: SubjectOption) => void;
};

/** The popover body; mounted only while open, so a closed filter fetches nothing. */
function SubjectPicker({
  resource,
  value,
  onChange,
  searchPlaceholder,
  listLabel,
  peopleOnly,
  known,
  onSeen,
}: SubjectPickerProps) {
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search, 250);
  const { data: session } = useSession();
  const me = session?.user;
  const recipients = usePermissionRecipients({
    resource,
    scope: "*",
    query,
    enabled: true,
  });

  const toOption = (recipient: PermissionRecipient): SubjectOption => {
    const isMe = peopleOnly && recipient.subject.id === me?.id;
    return {
      value: peopleOnly
        ? recipient.subject.id
        : permissionSubjectKey(recipient.subject),
      label: isMe ? "Me" : permissionRecipientLabel(recipient),
      recipient: isMe ? { ...recipient, name: "Me" } : recipient,
    };
  };
  const meOption: SubjectOption | null =
    peopleOnly && me
      ? toOption({
          subject: { type: "user", id: me.id },
          name: me.name,
          email: me.email,
        })
      : null;
  const results = (recipients.data ?? []).filter(
    (recipient) => !peopleOnly || recipient.subject.type === "user",
  );
  const seen = new Map(known);
  for (const recipient of results) {
    const option = toOption(recipient);
    seen.set(option.value, option);
  }
  if (meOption) seen.set(meOption.value, meOption);

  const selected = new Set(value);
  const pickedOptions = value.map(
    (key) => seen.get(key) ?? fallbackOption({ key, peopleOnly }),
  );
  const showMe =
    !!meOption &&
    !selected.has(meOption.value) &&
    (!search ||
      "me".includes(search.trim().toLowerCase()) ||
      `${me?.name ?? ""} ${me?.email ?? ""}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()));
  const unpicked = results.filter((recipient) => {
    const option = toOption(recipient);
    return !selected.has(option.value) && option.value !== meOption?.value;
  });
  const groups = groupPermissionRecipients(unpicked).map((group) => ({
    label: group.label,
    options: group.recipients.map(toOption),
  }));
  const searching = recipients.isLoading || query !== search;

  const toggle = (option: SubjectOption) => {
    onSeen(option);
    onChange(
      selected.has(option.value)
        ? value.filter((key) => key !== option.value)
        : [...value, option.value],
    );
  };

  return (
    <>
      <div className="flex items-center border-b px-3 py-2">
        <Search
          className="mr-2 size-4 shrink-0 opacity-50"
          aria-hidden="true"
        />
        <input
          aria-label={searchPlaceholder}
          placeholder={`${searchPlaceholder}…`}
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
        // biome-ignore lint/a11y/useSemanticElements: a group of checkbox rows, not a form fieldset
        <div
          role="group"
          aria-label={listLabel}
          className="max-h-[300px] overflow-y-auto p-1"
          onWheelCapture={(event) => event.stopPropagation()}
        >
          {pickedOptions.length > 0 && (
            <OptionGroup label="Selected">
              {pickedOptions.map((option) => (
                <OptionRow
                  key={option.value}
                  option={option}
                  on
                  onToggle={() => toggle(option)}
                />
              ))}
            </OptionGroup>
          )}
          {showMe && meOption && (
            <OptionRow
              option={meOption}
              on={false}
              onToggle={() => toggle(meOption)}
            />
          )}
          {searching ? (
            <output className="block px-4 py-6 text-center text-sm text-muted-foreground">
              <span>Searching…</span>
            </output>
          ) : groups.length === 0 ? (
            !showMe &&
            pickedOptions.length === 0 && (
              <output className="block px-4 py-6 text-center text-sm text-muted-foreground">
                <span>{search ? "No matches." : "Nobody to pick."}</span>
              </output>
            )
          ) : (
            groups.map((group) => (
              <OptionGroup
                key={group.label}
                label={peopleOnly ? null : group.label}
              >
                {group.options.map((option) => (
                  <OptionRow
                    key={option.value}
                    option={option}
                    on={false}
                    onToggle={() => toggle(option)}
                  />
                ))}
              </OptionGroup>
            ))
          )}
        </div>
      )}
    </>
  );
}

function OptionGroup({
  label,
  children,
}: {
  label: string | null;
  children: ReactNode;
}) {
  if (!label) return <div className="py-1">{children}</div>;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a section of checkbox rows inside a popover, not a form fieldset
    <div role="group" aria-label={label} className="py-1">
      <div
        aria-hidden="true"
        className="px-2 py-1 text-xs font-medium text-muted-foreground"
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function OptionRow({
  option,
  on,
  onToggle,
}: {
  option: SubjectOption;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <UnstyledButton
      role="checkbox"
      aria-checked={on}
      aria-label={option.label}
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm border",
          on && "border-primary bg-primary text-primary-foreground",
        )}
      >
        {on && <Check className="size-3" />}
      </span>
      <span className="min-w-0 flex-1">
        <PermissionRecipientIdentity
          recipient={{ ...option.recipient, name: option.label }}
        />
      </span>
    </UnstyledButton>
  );
}

/** A picked value from a bookmarked URL whose recipient was not loaded yet. */
function fallbackOption({
  key,
  peopleOnly,
}: {
  key: string;
  peopleOnly: boolean;
}): SubjectOption {
  const subject: PermissionSubject = (!peopleOnly &&
    parsePermissionSubjectKey(key)) || { type: "user", id: key };
  const recipient = { subject, name: subject.id };
  return { value: key, label: permissionRecipientLabel(recipient), recipient };
}
