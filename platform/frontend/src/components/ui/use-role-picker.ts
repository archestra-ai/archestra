// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type PredefinedRoleName,
  roleDescriptions,
  roleDisplayNames,
} from "@archestra/shared";
import { findUngrantablePermissions } from "@archestra/shared/access-control";
import { fixedRoleGroups } from "@archestra/shared/fixed-roles";
import type * as React from "react";
import { useMemo } from "react";
// biome-ignore lint/style/noRestrictedImports: this file is enterprise code itself (see the SPDX header); it needs the same permission labels the roles pages show
import { allPermissionRows } from "@/components/roles/permission-list-model.ee";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { useRoles } from "@/lib/role.query";
import { matchesSearchTokens } from "@/lib/search-tokens";
import { formatRoleName } from "@/lib/utils/role";

/**
 * The three kinds of role an assignment can mix:
 * - `preset`: the complete, opinionated roles shipped with the product
 *   (Admin, Platform Admin, Editor, Member). A starting point on their own.
 * - `granular`: small built-in roles that each grant one slice of access
 *   ("Agent Reader"), composed a few at a time.
 * - `custom`: roles the organization authored.
 */
export type RoleKind = "preset" | "granular" | "custom";

/** What each kind is called wherever roles are listed or picked. */
export const roleKindLabels: Record<RoleKind, string> = {
  preset: "Preset roles",
  granular: "Granular roles",
  custom: "Custom roles",
};

export const roleKindDescriptions: Record<RoleKind, string> = {
  preset: "Complete roles to start from. One is usually enough.",
  granular:
    "Small built-in roles. Combine a few for exactly the access needed.",
  custom: "Roles your organization created.",
};

export interface RolePermissionLabel {
  /** `resource:action`, as the API spells it. */
  key: string;
  /** "View agents". */
  label: string;
}

export interface RoleOption {
  /** The role identifier, as stored. */
  value: string;
  label: string;
  description: string;
  kind: RoleKind;
  groupId: string;
  groupName: string;
  permission: Record<string, string[]>;
  permissions: RolePermissionLabel[];
}

export interface RoleGroup {
  id: string;
  name: string;
  kind: RoleKind;
  options: RoleOption[];
}

export interface RoleGroupState {
  selectedCount: number;
  total: number;
  checked: boolean | "indeterminate";
  /** Nothing in the group can be granted by the current user. */
  disabled: boolean;
}

export interface RolePickerProps {
  /** Selected role identifiers, comma-separated, as roles are stored. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Fewest roles an assignment may hold; 0 lets it be emptied. */
  minSelected?: number;
  maxBadgeDisplay?: number;
  /**
   * Lock roles carrying permissions the current user does not hold. Off for
   * pickers that configure a mapping rather than grant a role.
   */
  restrictToGrantable?: boolean;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  className?: string;
  "data-testid"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
}

/**
 * Everything a role picker needs besides its looks: the catalog of roles
 * grouped by kind and area, which of them the assignment holds, and the
 * operations on it. Changes apply at once through `onValueChange`; the form
 * around the picker is what saves.
 */
export function useRolePicker({
  value,
  onValueChange,
  minSelected = 1,
  restrictToGrantable = true,
  disabled = false,
}: Pick<
  RolePickerProps,
  "value" | "onValueChange" | "minSelected" | "restrictToGrantable" | "disabled"
>) {
  const { data: roles, isPending } = useRoles();
  const { data: userPermissions } = useAllPermissions();

  const groups = useMemo(() => buildGroups(roles ?? []), [roles]);
  const optionsByValue = useMemo(
    () =>
      new Map(
        groups.flatMap((group) =>
          group.options.map((option) => [option.value, option] as const),
        ),
      ),
    [groups],
  );
  const selected = useMemo(() => splitRoles(value ?? ""), [value]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const commit = (next: string[]) => {
    if (disabled) return;
    onValueChange?.(next.join(","));
  };

  const missingFor = (option: RoleOption): string[] =>
    restrictToGrantable && userPermissions
      ? findUngrantablePermissions(userPermissions, option.permission)
      : [];
  const isSelected = (role: string) => selectedSet.has(role);
  /** Cannot be added: it grants something the current user does not hold. */
  const isLocked = (option: RoleOption) =>
    !isSelected(option.value) && missingFor(option).length > 0;
  /** Removing it would leave fewer roles than the assignment must hold. */
  const isLastRequired = (role: string) =>
    isSelected(role) && selected.length <= minSelected;

  const toggle = (option: RoleOption) => {
    if (isSelected(option.value)) {
      if (isLastRequired(option.value)) return;
      commit(selected.filter((role) => role !== option.value));
    } else if (!isLocked(option)) {
      commit([...selected, option.value]);
    }
  };
  const remove = (role: string) => {
    if (isLastRequired(role)) return;
    commit(selected.filter((entry) => entry !== role));
  };

  const groupState = (group: RoleGroup): RoleGroupState => {
    const pickable = group.options.filter((option) => !isLocked(option));
    const selectedCount = group.options.filter((option) =>
      isSelected(option.value),
    ).length;
    const allOn =
      pickable.length > 0 &&
      pickable.every((option) => isSelected(option.value));
    return {
      selectedCount,
      total: group.options.length,
      checked: allOn ? true : selectedCount > 0 ? "indeterminate" : false,
      disabled: pickable.length === 0,
    };
  };
  /** Take every role of the group the user may grant, or drop them all. */
  const toggleGroup = (group: RoleGroup) => {
    const state = groupState(group);
    if (state.checked === true) {
      const inGroup = new Set(group.options.map((option) => option.value));
      const next = selected.filter((role) => !inGroup.has(role));
      if (next.length >= minSelected) commit(next);
      return;
    }
    const additions = group.options
      .filter((option) => !isLocked(option) && !isSelected(option.value))
      .map((option) => option.value);
    commit([...selected, ...additions]);
  };
  const clearGroup = (group: RoleGroup) => {
    const inGroup = new Set(group.options.map((option) => option.value));
    const next = selected.filter((role) => !inGroup.has(role));
    if (next.length >= minSelected) commit(next);
  };
  const canClear = minSelected === 0 && selected.length > 0;
  const clear = () => {
    if (canClear) commit([]);
  };

  /**
   * A selected preset or custom role that already grants everything this
   * role does, making it redundant alongside.
   */
  const coveredBy = (option: RoleOption): RoleOption | undefined => {
    for (const role of selected) {
      if (role === option.value) continue;
      const other = optionsByValue.get(role);
      if (!other || other.kind === "granular") continue;
      const held = new Set(other.permissions.map((entry) => entry.key));
      if (
        option.permissions.length > 0 &&
        option.permissions.every((entry) => held.has(entry.key))
      )
        return other;
    }
    return undefined;
  };

  /** Roles matching a search across every group; [] for a blank query. */
  const search = (query: string) => {
    if (!query.trim()) return [];
    return groups.flatMap((group) =>
      group.options
        .filter((option) =>
          matchesSearchTokens(query, [
            option.label,
            option.value,
            option.description,
            group.name,
            ...option.permissions.flatMap((entry) => [entry.key, entry.label]),
          ]),
        )
        .map((option) => ({ option, group })),
    );
  };

  const labelFor = (role: string) =>
    optionsByValue.get(role)?.label ?? formatRoleName(role);
  const effectivePermissionCount = new Set(
    selected.flatMap(
      (role) =>
        optionsByValue.get(role)?.permissions.map((entry) => entry.key) ?? [],
    ),
  ).size;

  return {
    isPending,
    disabled,
    minSelected,
    /** Presets, then custom roles (when any exist), then the granular areas. */
    groups,
    presets: groups.find((group) => group.kind === "preset")?.options ?? [],
    custom: groups.find((group) => group.kind === "custom")?.options ?? [],
    granularGroups: groups.filter((group) => group.kind === "granular"),
    optionsByValue,
    selected,
    isSelected,
    isLocked,
    isLastRequired,
    missingFor,
    coveredBy,
    toggle,
    remove,
    groupState,
    toggleGroup,
    clearGroup,
    canClear,
    clear,
    search,
    labelFor,
    effectivePermissionCount,
  };
}

export type RolePickerState = ReturnType<typeof useRolePicker>;

// === Internal helpers

const PRESET_GROUP_ID = "preset";
const CUSTOM_GROUP_ID = "custom";

/** Most access first, the order a reader weighs them in. */
const PRESET_ORDER: string[] = ["admin", "platform_admin", "editor", "member"];

const PERMISSION_LABELS = new Map(
  allPermissionRows.map((row) => [row.key, row.label]),
);

type ListedRole = {
  role: string;
  name: string;
  description?: string | null;
  predefined: boolean;
  permission?: Record<string, string[]>;
};

function buildGroups(roles: ListedRole[]): RoleGroup[] {
  const presets = roles
    .filter((role) => role.predefined)
    .sort(
      (a, b) =>
        presetRank(a.role) - presetRank(b.role) || a.name.localeCompare(b.name),
    )
    .map((role) =>
      toOption({
        value: role.role,
        label:
          roleDisplayNames[role.role as PredefinedRoleName] ??
          formatRoleName(role.name),
        description:
          role.description ||
          roleDescriptions[role.role as PredefinedRoleName] ||
          "",
        kind: "preset",
        groupId: PRESET_GROUP_ID,
        groupName: roleKindLabels.preset,
        permission: role.permission ?? {},
      }),
    );
  const custom = roles
    .filter((role) => !role.predefined)
    .map((role) =>
      toOption({
        value: role.role,
        // A custom role's name is already what its author wants shown.
        label: role.name,
        description: role.description ?? "",
        kind: "custom",
        groupId: CUSTOM_GROUP_ID,
        groupName: roleKindLabels.custom,
        permission: role.permission ?? {},
      }),
    );
  return [
    {
      id: PRESET_GROUP_ID,
      name: roleKindLabels.preset,
      kind: "preset",
      options: presets,
    },
    ...(custom.length > 0
      ? [
          {
            id: CUSTOM_GROUP_ID,
            name: roleKindLabels.custom,
            kind: "custom" as const,
            options: custom,
          },
        ]
      : []),
    ...fixedRoleGroups.map((group) => ({
      id: `granular:${group.id}`,
      name: group.name,
      kind: "granular" as const,
      options: group.roles.map((role) =>
        toOption({
          value: role.role,
          label: role.name,
          description: role.description,
          kind: "granular",
          groupId: `granular:${group.id}`,
          groupName: group.name,
          permission: role.permission as Record<string, string[]>,
        }),
      ),
    })),
  ];
}

function toOption(option: Omit<RoleOption, "permissions">): RoleOption {
  return {
    ...option,
    // Only what a person can be granted and read: a key without a label is
    // either internal to the auth library (`organization:update`) or an
    // action a stored role still names after it was removed, and grants
    // nothing. Showing its raw key would only raise a question.
    permissions: Object.entries(option.permission).flatMap(
      ([resource, actions]) =>
        (actions ?? []).flatMap((action) => {
          const key = `${resource}:${action}`;
          const label = PERMISSION_LABELS.get(key);
          return label ? [{ key, label }] : [];
        }),
    ),
  };
}

function presetRank(role: string): number {
  const index = PRESET_ORDER.indexOf(role);
  return index === -1 ? PRESET_ORDER.length : index;
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
