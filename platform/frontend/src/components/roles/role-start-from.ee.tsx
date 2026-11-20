// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type archestraApiTypes,
  type PredefinedRoleName,
  roleDescriptions,
  roleDisplayNames,
} from "@archestra/shared";
import {
  Copy,
  FilePlus2,
  type LucideIcon,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import { cn } from "@/lib/utils/tailwind";
import { allPermissionRows, countGranted } from "./permission-list-model.ee";

type Role = archestraApiTypes.GetRolesResponses["200"]["data"][number];

type Mode = "blank" | "preset" | "custom";

type Option = {
  id: string;
  name: string;
  description: string;
  count: number;
};

/** No role to copy: the new role starts with nothing granted. */
export const BLANK_START = "blank";

/**
 * Where a new custom role's permissions start: blank, one of the preset
 * roles, or a copy of another custom role. The author answers that one
 * question first and only the chosen branch shows its options. Granular
 * roles are not offered: each is a single slice of access, too small to be a
 * useful starting point.
 */
export function RoleStartFrom({
  roles,
  value,
  onChange,
}: {
  roles: Role[];
  value: string;
  onChange: (value: string) => void;
}) {
  const presets: Option[] = PRESET_ORDER.flatMap((key) => {
    const role = roles.find((entry) => entry.predefined && entry.role === key);
    if (!role) return [];
    return [
      {
        id: role.id,
        name: roleDisplayNames[key],
        description: roleDescriptions[key],
        count: countGranted(role.permission, allPermissionRows),
      },
    ];
  });
  const customs: Option[] = roles
    .filter((role) => !role.predefined)
    .map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description ?? "",
      count: countGranted(role.permission, allPermissionRows),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // The mode follows the value when it names a role. With nothing chosen
  // ("blank"), it is whichever branch the author last opened.
  const [opened, setOpened] = useState<Mode>("blank");
  const [lastPreset, setLastPreset] = useState<string | null>(null);
  const mode: Mode = presets.some((option) => option.id === value)
    ? "preset"
    : customs.some((option) => option.id === value)
      ? "custom"
      : opened;

  const onModeChange = (next: string) => {
    setOpened(next as Mode);
    if (next === "preset") {
      const keep = presets.find((option) => option.id === lastPreset);
      // Member is the last preset: the least access, the safest default.
      const fallback = keep ?? presets[presets.length - 1];
      onChange(fallback ? fallback.id : BLANK_START);
    } else {
      // Custom starts with nothing picked, which is a blank role until then.
      onChange(BLANK_START);
    }
  };

  const hasCustom = customs.length > 0;

  return (
    <div className="@container flex min-w-0 flex-col gap-3">
      <RadioGroup
        value={mode}
        onValueChange={onModeChange}
        aria-label="How to start"
        className="grid grid-cols-1 gap-2 @xl:grid-cols-3"
      >
        <ModeCard
          value="blank"
          icon={FilePlus2}
          title="Start blank"
          hint="Nothing granted"
        />
        <ModeCard
          value="preset"
          icon={ShieldCheck}
          title="Start from a preset"
          hint="Admin, Platform Admin, Editor or Member"
          disabled={presets.length === 0}
        />
        <ModeCard
          value="custom"
          icon={Copy}
          title="Copy a custom role"
          hint={
            hasCustom
              ? `${customs.length} in this organization`
              : "No custom roles yet"
          }
          disabled={!hasCustom}
        />
      </RadioGroup>

      {mode === "blank" && (
        <p className="px-1 text-sm text-muted-foreground">
          You pick every permission on the next step.
        </p>
      )}

      {mode === "preset" && (
        <PresetRow
          options={presets}
          value={value}
          onChange={(id) => {
            setLastPreset(id);
            onChange(id);
          }}
        />
      )}

      {mode === "custom" && (
        <CustomList options={customs} value={value} onChange={onChange} />
      )}
    </div>
  );
}

const TOTAL = allPermissionRows.length;
const PRESET_ORDER = Object.keys(roleDisplayNames) as PredefinedRoleName[];
/** Below this many custom roles the list is short enough to scan. */
const SEARCH_FROM = 7;

function ModeCard({
  value,
  icon: Icon,
  title,
  hint,
  disabled,
}: {
  value: Mode;
  icon: LucideIcon;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <Label
      className={cn(
        "group flex min-h-14 cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 font-normal",
        radioCardClass(),
      )}
    >
      <RadioGroupItem value={value} disabled={disabled} className="sr-only" />
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-has-[[data-state=checked]]:bg-primary group-has-[[data-state=checked]]:text-primary-foreground">
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm leading-tight font-medium">{title}</span>
        <span className="text-xs leading-tight text-muted-foreground">
          {hint}
        </span>
      </span>
    </Label>
  );
}

function PresetRow({
  options,
  value,
  onChange,
}: {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
}) {
  const chosen = options.find((option) => option.id === value);
  return (
    <div className="flex flex-col gap-2">
      <RadioGroup
        value={value}
        onValueChange={onChange}
        aria-label="Preset roles"
        className="grid grid-cols-1 gap-2 @sm:grid-cols-2 @3xl:grid-cols-4"
      >
        {options.map((option) => (
          <Label
            key={option.id}
            className={cn(
              "flex min-h-16 cursor-pointer flex-col items-stretch gap-2 rounded-lg p-3 font-normal",
              radioCardClass(),
            )}
          >
            <span className="flex items-center gap-2">
              <RadioGroupItem value={option.id} />
              <span className="min-w-0 truncate text-sm font-medium">
                {option.name}
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {option.count}
              </span>
            </span>
            <AccessMeter count={option.count} active={option.id === value} />
          </Label>
        ))}
      </RadioGroup>
      {chosen && (
        <p
          key={chosen.id}
          aria-live="polite"
          className="px-1 text-sm text-muted-foreground"
        >
          <span className="font-medium text-foreground">{chosen.name}</span>
          <span>
            {" "}
            starts with {chosen.count} of {TOTAL} permissions.{" "}
          </span>
          <span>{chosen.description}.</span>
        </p>
      )}
    </div>
  );
}

function CustomList({
  options,
  value,
  onChange,
}: {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // A deep-linked role may sit far down the list: bring it into view without
  // scrolling the page.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>("[data-chosen=true]");
    if (!list || !row) return;
    list.scrollTop = Math.max(
      0,
      row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2,
    );
  }, []);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? options.filter(
        (option) =>
          option.name.toLowerCase().includes(needle) ||
          option.description.toLowerCase().includes(needle),
      )
    : options;
  // The chosen role stays on screen even when the search no longer matches it.
  const chosen = options.find((option) => option.id === value);
  const pinned = chosen && !matches.includes(chosen) ? chosen : null;
  const shown = pinned ? [pinned, ...matches] : matches;

  return (
    <div className="flex flex-col gap-2">
      {options.length >= SEARCH_FROM && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${options.length} custom roles`}
            aria-label="Search custom roles"
            className="h-10 pl-9"
          />
        </div>
      )}
      <div
        ref={listRef}
        className="relative max-h-72 overflow-y-auto rounded-lg border bg-raised"
      >
        <RadioGroup
          value={value}
          onValueChange={onChange}
          aria-label="Custom roles"
          className="gap-0 divide-y"
        >
          {shown.map((option) => {
            const active = option.id === value;
            return (
              <Label
                key={option.id}
                data-chosen={active}
                className={cn(
                  "flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 font-normal transition-colors hover:bg-muted/50",
                  "ring-inset has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                  active && "bg-primary/5 hover:bg-primary/5",
                )}
              >
                <RadioGroupItem value={option.id} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm leading-tight font-medium">
                    {option.name}
                  </span>
                  {option.description && (
                    <span className="truncate text-xs leading-tight text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
                <span className="flex w-16 shrink-0 flex-col items-end gap-1">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {option.count}
                  </span>
                  <AccessMeter count={option.count} active={active} />
                </span>
              </Label>
            );
          })}
        </RadioGroup>
        {matches.length === 0 && (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">
            No custom role matches that search.
          </p>
        )}
      </div>
      <p className="px-1 text-sm text-muted-foreground">
        {chosen ? (
          <span key="chosen">
            <span className="font-medium text-foreground">{chosen.name}</span>
            <span>
              {" "}
              starts with {chosen.count} of {TOTAL} permissions.
            </span>
          </span>
        ) : (
          <span key="none">
            Pick a role to copy. Until you do, the new role starts blank.
          </span>
        )}
      </p>
    </div>
  );
}

/** How much of every possible permission a starting point grants. */
function AccessMeter({ count, active }: { count: number; active: boolean }) {
  const share = TOTAL > 0 ? Math.min(1, count / TOTAL) : 0;
  return (
    <span
      aria-hidden
      className="block h-1 w-full overflow-hidden rounded-full bg-muted"
    >
      <span
        className={cn(
          "block h-full rounded-full transition-[width,background-color] duration-300",
          active ? "bg-primary" : "bg-muted-foreground/50",
        )}
        style={{ width: `${count > 0 ? Math.max(4, share * 100) : 0}%` }}
      />
    </span>
  );
}
