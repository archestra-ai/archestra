// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { findUngrantablePermissions } from "@archestra/shared/access-control";
import { fixedRoleGroups } from "@archestra/shared/fixed-roles";
import { ChevronDown, ChevronRight, Info, Search, X } from "lucide-react";
import * as React from "react";
import { RoleOptionLabel } from "@/components/role-type-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { useRoles } from "@/lib/role.query";
import { matchesSearchTokens } from "@/lib/search-tokens";
import { formatRoleName } from "@/lib/utils/role";
import { cn } from "@/lib/utils/tailwind";

interface RolePickerProps {
  /** Selected role identifiers, comma-separated, as roles are stored. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Fewest roles Update accepts; 0 lets the selection be emptied. */
  minSelected?: number;
  maxBadgeDisplay?: number;
  /**
   * Disable roles carrying permissions the current user does not hold. Off
   * for pickers that configure a mapping rather than grant a role.
   */
  restrictToGrantable?: boolean;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
  "data-testid"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
}

/**
 * Picks any mix of basic, custom and fixed roles, Grafana-style: groups on the
 * left, the open group's roles on the right. The left checkbox takes or drops
 * a whole group. Choices are staged until Update, so browsing a few groups
 * does not change the assignment underneath the form; closing discards them.
 * A chip's remove button applies immediately, as on the other pickers.
 */
export function RolePicker({
  value,
  onValueChange,
  minSelected = 1,
  maxBadgeDisplay = 3,
  restrictToGrantable = true,
  disabled = false,
  id,
  ariaLabel = "Roles",
  className,
  "data-testid": testId,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: RolePickerProps) {
  const { data: roles = [], isPending } = useRoles();
  const { data: userPermissions } = useAllPermissions();
  const groups = React.useMemo(() => buildGroups(roles), [roles]);
  const selected = React.useMemo(() => splitRoles(value ?? ""), [value]);
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<string[]>(selected);
  const [activeGroupId, setActiveGroupId] = React.useState<string>(
    groups[0]?.id ?? "",
  );
  const [query, setQuery] = React.useState("");

  const missingFor = (option: RoleOption) =>
    restrictToGrantable && userPermissions
      ? findUngrantablePermissions(userPermissions, option.permission)
      : [];
  const isPickable = (option: RoleOption) => missingFor(option).length === 0;
  const optionsById = new Map(
    groups.flatMap((group) => group.options.map((o) => [o.value, o] as const)),
  );
  const labelFor = (role: string) =>
    optionsById.get(role)?.label ?? formatRoleName(role);

  const openPicker = (next: boolean) => {
    if (disabled) return;
    if (next) {
      setDraft(selected);
      setQuery("");
      // Open on the group holding the first selected role, where the reader
      // most likely wants to look.
      const first = selected
        .map((role) =>
          groups.find((g) => g.options.some((o) => o.value === role)),
        )
        .find(Boolean);
      setActiveGroupId(first?.id ?? groups[0]?.id ?? "");
    }
    setOpen(next);
  };
  const toggle = (role: string) =>
    setDraft((current) =>
      current.includes(role)
        ? current.filter((entry) => entry !== role)
        : [...current, role],
    );
  const toggleGroup = (group: RoleGroup) => {
    const pickable = group.options.filter(isPickable).map((o) => o.value);
    const allOn = pickable.every((role) => draft.includes(role));
    setDraft((current) =>
      allOn
        ? current.filter((role) => !pickable.includes(role))
        : [...current, ...pickable.filter((role) => !current.includes(role))],
    );
  };
  const clearGroup = (group: RoleGroup) =>
    setDraft((current) =>
      current.filter((role) => !group.options.some((o) => o.value === role)),
    );
  const apply = () => {
    onValueChange?.(draft.join(","));
    setOpen(false);
  };
  const remove = (role: string, event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onValueChange?.(selected.filter((entry) => entry !== role).join(","));
  };

  const activeGroup =
    groups.find((group) => group.id === activeGroupId) ?? groups[0];
  const searching = query.trim().length > 0;
  const matches = searching
    ? groups.flatMap((group) =>
        group.options
          .filter((option) =>
            matchesSearchTokens(query, [
              option.label,
              option.value,
              option.description,
              group.name,
            ]),
          )
          .map((option) => ({ option, group })),
      )
    : [];
  const visibleBadges = selected.slice(0, maxBadgeDisplay);
  const hiddenCount = selected.length - visibleBadges.length;

  const renderOption = (option: RoleOption, groupName?: string) => {
    const missing = missingFor(option);
    const checkboxId = `${id ?? "role-picker"}-${option.value}`;
    return (
      <li
        key={option.value}
        className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent"
      >
        <Checkbox
          id={checkboxId}
          checked={draft.includes(option.value)}
          disabled={missing.length > 0 && !draft.includes(option.value)}
          onCheckedChange={() => toggle(option.value)}
        />
        <label
          htmlFor={checkboxId}
          className={cn(
            "min-w-0 flex-1 cursor-pointer truncate text-sm",
            missing.length > 0 && "cursor-not-allowed text-muted-foreground",
          )}
        >
          {option.kind === "fixed" ? (
            option.label
          ) : (
            <RoleOptionLabel
              predefined={option.kind === "basic"}
              label={option.label}
            />
          )}
          {groupName ? (
            <span className="ml-1.5 text-xs text-muted-foreground">
              {groupName}
            </span>
          ) : null}
        </label>
        <RoleInfo option={option} missing={missing} />
      </li>
    );
  };

  return (
    <Popover open={!disabled && open} onOpenChange={openPicker}>
      <PopoverTrigger asChild>
        <div
          role="combobox"
          id={id}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          aria-expanded={open}
          aria-disabled={disabled}
          data-testid={testId}
          tabIndex={disabled ? -1 : 0}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openPicker(!open);
            }
          }}
          className={cn(
            "flex h-auto min-h-9 w-full cursor-pointer items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            disabled && "cursor-not-allowed opacity-50",
            className,
          )}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {selected.length === 0 ? (
              <span className="text-muted-foreground">
                {isPending ? "Loading roles…" : "Select roles"}
              </span>
            ) : (
              <>
                {visibleBadges.map((role) => (
                  <Badge key={role} variant="secondary">
                    <span>{labelFor(role)}</span>
                    <UnstyledButton
                      type="button"
                      aria-label={`Remove ${labelFor(role)}`}
                      disabled={disabled || selected.length <= minSelected}
                      className="ml-1 rounded-full outline-none ring-offset-background focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-40"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => remove(role, event)}
                    >
                      <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                    </UnstyledButton>
                  </Badge>
                ))}
                {hiddenCount > 0 ? (
                  <Badge variant="secondary">+{hiddenCount} more</Badge>
                ) : null}
              </>
            )}
          </div>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden p-0"
      >
        <div className="flex items-center border-b px-3">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <Input
            aria-label="Search roles"
            placeholder="Search roles..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        {searching ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {matches.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No matching roles found.
              </p>
            ) : (
              <ul aria-label="Matching roles">
                {matches.map(({ option, group }) =>
                  renderOption(option, group.name),
                )}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <nav
              aria-label="Role groups"
              className="flex w-56 shrink-0 flex-col overflow-y-auto border-r p-1"
            >
              {groups.map((group, index) => {
                const pickable = group.options.filter(isPickable);
                const chosen = group.options.filter((o) =>
                  draft.includes(o.value),
                ).length;
                const allOn =
                  pickable.length > 0 &&
                  pickable.every((o) => draft.includes(o.value));
                const showHeader =
                  group.section === "fixed" &&
                  groups[index - 1]?.section !== "fixed";
                return (
                  <React.Fragment key={group.id}>
                    {showHeader ? (
                      <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                        Fixed roles
                      </div>
                    ) : null}
                    <div
                      className={cn(
                        "flex items-center gap-2 rounded-sm px-2 py-1.5",
                        group.id === activeGroup?.id
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/60",
                      )}
                    >
                      {group.section === "basic" ? (
                        // Holding every basic role at once means nothing a
                        // reader would ask for; take them one at a time.
                        <span className="size-4 shrink-0" />
                      ) : (
                        <Checkbox
                          aria-label={`Select all ${group.name} roles`}
                          checked={
                            allOn ? true : chosen > 0 ? "indeterminate" : false
                          }
                          disabled={pickable.length === 0}
                          onCheckedChange={() => toggleGroup(group)}
                        />
                      )}
                      <UnstyledButton
                        type="button"
                        aria-current={group.id === activeGroup?.id}
                        className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left text-sm"
                        onClick={() => setActiveGroupId(group.id)}
                        onFocus={() => setActiveGroupId(group.id)}
                        onMouseEnter={() => setActiveGroupId(group.id)}
                      >
                        <span className="truncate">{group.name}</span>
                        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          {chosen > 0 ? <span>{chosen}</span> : null}
                          <ChevronRight className="h-3.5 w-3.5" />
                        </span>
                      </UnstyledButton>
                    </div>
                  </React.Fragment>
                );
              })}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                {activeGroup?.name}
              </div>
              <ul
                aria-label={`${activeGroup?.name ?? ""} roles`}
                className="min-h-0 flex-1 overflow-y-auto px-1 pb-1"
              >
                {activeGroup?.options.map((option) => renderOption(option))}
              </ul>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t px-2 py-2">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDraft([])}
            >
              Clear all
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={draft.length < minSelected}
              title={
                draft.length < minSelected
                  ? "Select at least one role"
                  : undefined
              }
              onClick={apply}
            >
              Update
            </Button>
          </div>
          {!searching && activeGroup ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => clearGroup(activeGroup)}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// === Internal helpers

type RoleKind = "basic" | "custom" | "fixed";

interface RoleOption {
  value: string;
  label: string;
  description?: string | null;
  kind: RoleKind;
  permission: Record<string, string[]>;
}

interface RoleGroup {
  id: string;
  name: string;
  section: RoleKind;
  options: RoleOption[];
}

type ListedRole = {
  role: string;
  name: string;
  description?: string | null;
  predefined: boolean;
  permission?: Record<string, string[]>;
};

function buildGroups(roles: ListedRole[]): RoleGroup[] {
  const toOption = (role: ListedRole): RoleOption => ({
    value: role.role,
    label: formatRoleName(role.name),
    description: role.description,
    kind: role.predefined ? "basic" : "custom",
    permission: role.permission ?? {},
  });
  const basic = roles.filter((role) => role.predefined).map(toOption);
  const custom = roles.filter((role) => !role.predefined).map(toOption);
  return [
    { id: "basic", name: "Basic roles", section: "basic", options: basic },
    ...(custom.length > 0
      ? [
          {
            id: "custom",
            name: "Custom roles",
            section: "custom" as const,
            options: custom,
          },
        ]
      : []),
    ...fixedRoleGroups.map((group) => ({
      id: `fixed:${group.id}`,
      name: group.name,
      section: "fixed" as const,
      options: group.roles.map((role) => ({
        value: role.role,
        label: role.name,
        description: role.description,
        kind: "fixed" as const,
        permission: role.permission as Record<string, string[]>,
      })),
    })),
  ];
}

function splitRoles(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((role) => role.trim())
        .filter(Boolean),
    ),
  ];
}

function RoleInfo({
  option,
  missing,
}: {
  option: RoleOption;
  missing: string[];
}) {
  const permissions = Object.entries(option.permission).flatMap(
    ([resource, actions]) => actions.map((action) => `${resource}:${action}`),
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          type="button"
          aria-label={`About ${option.label}`}
          className="shrink-0 rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="h-3.5 w-3.5" />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs space-y-1 text-left">
        {option.description ? <p>{option.description}</p> : null}
        {option.kind === "fixed" ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            {permissions.join(", ")}
          </p>
        ) : null}
        {missing.length > 0 ? (
          <p className="text-muted-foreground">
            Grants permissions you don't hold: {missing.join(", ")}
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
