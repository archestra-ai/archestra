// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { ResourcePermissionAction } from "@archestra/shared";
import {
  Crown,
  Eye,
  KeyRound,
  type LucideIcon,
  Pencil,
  Play,
  Server,
  ShieldAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils/tailwind";

export type PermissionLevelOption = {
  value: string;
  label: string;
  description: string;
  actions: readonly ResourcePermissionAction[];
  disabled?: boolean;
};

/**
 * The one dropdown for choosing what a recipient can do. Every place that
 * grants access renders it, so a level always reads the same way: an icon
 * and a label in the list, and below it what the highlighted level includes,
 * adds, and leaves out.
 */
export function PermissionLevelSelect({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled,
  valueLabel,
  title,
  extraOption,
  inline = false,
  action,
  className,
}: {
  value: string;
  options: PermissionLevelOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Replaces the selected label in the trigger, e.g. "Custom". */
  valueLabel?: ReactNode;
  /** Hover text on the trigger. */
  title?: string;
  /** A disabled entry for a value no option matches, so the list shows it. */
  extraOption?: { value: string; label: string };
  /** Text-only trigger for a grant row: the level and a chevron, no icon or box. */
  inline?: boolean;
  /**
   * One command after the levels, such as "Make owner". Choosing it runs
   * `onSelect` and leaves the level as it is.
   */
  action?: {
    label: string;
    description: string;
    disabled?: boolean;
    onSelect: () => void;
  };
  className?: string;
}) {
  // The level the detail explains: the highlighted one while the list is
  // open, otherwise the chosen one.
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const selected = options.find((option) => option.value === value);
  const SelectedIcon = selected ? levelIcon(selected) : null;
  const shown =
    options.find((option) => option.value === highlighted) ?? selected;

  return (
    <Select
      disabled={disabled}
      value={value}
      onValueChange={(next) => {
        if (next === ACTION_VALUE) action?.onSelect();
        else onValueChange(next);
      }}
      onOpenChange={() => setHighlighted(null)}
    >
      <SelectTrigger
        size="sm"
        // Sized to fit the longest level ("Full access + deploy") so the
        // label is never cut off, and the same width in every list.
        className={cn(
          inline
            ? "w-auto shrink-0 gap-1 border-transparent bg-transparent px-2 text-left shadow-none hover:bg-muted dark:bg-transparent"
            : "w-56 shrink-0 text-left",
          className,
        )}
        aria-label={ariaLabel}
        title={title}
      >
        <SelectValue>
          <span className="flex min-w-0 items-center gap-2">
            {inline ? null : SelectedIcon && !valueLabel ? (
              <SelectedIcon className="size-4 text-muted-foreground" />
            ) : (
              // Holds the icon's place, so a custom set lines up too.
              <span className="size-4 shrink-0" />
            )}
            <span className="truncate">{valueLabel ?? selected?.label}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="end"
        className="w-[min(22rem,calc(100vw-2rem))]"
      >
        {options.map((option) => {
          const Icon = levelIcon(option);
          return (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              aria-description={option.description}
              icon={<Icon className="size-4" />}
              onFocus={() => setHighlighted(option.value)}
            >
              {option.label}
            </SelectItem>
          );
        })}
        {extraOption && (
          <SelectItem value={extraOption.value} disabled>
            {extraOption.label}
          </SelectItem>
        )}
        {action && (
          <>
            <SelectSeparator />
            <SelectItem
              value={ACTION_VALUE}
              disabled={action.disabled}
              description={action.description}
              icon={<Crown className="size-4" />}
              onFocus={() => setHighlighted(null)}
            >
              {action.label}
            </SelectItem>
          </>
        )}
        {shown && <LevelDetail option={shown} options={options} />}
      </SelectContent>
    </Select>
  );
}

/**
 * A level shown without a dropdown, for grants this list cannot change. It
 * takes the trigger's width, padding, and icon, so read-only and editable rows
 * share one permission column.
 */
export function PermissionLevelLabel({
  label,
  actions,
  title,
  className,
}: {
  label: ReactNode;
  actions: readonly ResourcePermissionAction[];
  title?: string;
  className?: string;
}) {
  const Icon = levelIcon({ actions });
  return (
    <span
      className={cn(
        "flex w-56 shrink-0 items-center gap-2 border border-transparent px-3 text-sm",
        className,
      )}
      title={title}
    >
      <Icon
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

// ===

function LevelDetail({
  option,
  options,
}: {
  option: PermissionLevelOption;
  options: PermissionLevelOption[];
}) {
  const index = options.indexOf(option);
  const below = index > 0 ? options[index - 1].actions : [];
  // Only what this resource can grant at all, in ladder order.
  const offered = actionOrder.filter((action) =>
    options.some((entry) => entry.actions.includes(action)),
  );
  return (
    <div
      data-testid="permission-level-detail"
      className="-mx-1 -mb-1 mt-1 space-y-2 border-t px-3 py-3"
    >
      <p className="text-sm font-medium">{option.label}</p>
      <p className="text-xs text-muted-foreground">{option.description}</p>
      <ul className="flex flex-wrap gap-1" aria-label="Capabilities">
        {offered.map((action) => {
          const included = option.actions.includes(action);
          const added = included && index > 0 && !below.includes(action);
          return (
            <li
              key={action}
              className={cn(
                "rounded px-1.5 py-px text-[11px]",
                included
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground line-through opacity-60",
                added && "ring-1 ring-foreground/70 ring-inset",
              )}
            >
              <span className="sr-only">
                {included ? (added ? "Adds " : "Includes ") : "Leaves out "}
              </span>
              {actionChipLabels[action]}
            </li>
          );
        })}
      </ul>
      {option.actions.includes("configure-deployment-spec") && (
        <p className="flex items-center gap-1.5 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
          <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
          Picks the service account and Secrets the server runs with
        </p>
      )}
    </div>
  );
}

function levelIcon(option: Pick<PermissionLevelOption, "actions">): LucideIcon {
  const has = (action: ResourcePermissionAction) =>
    option.actions.includes(action);
  if (has("configure-deployment-spec")) return Server;
  if (has("manage-permissions")) return KeyRound;
  if (has("update")) return Pencil;
  if (has("use")) return Play;
  return Eye;
}

// The action item's value: never a level, so the select never shows it.
const ACTION_VALUE = "__action";

const actionOrder: ResourcePermissionAction[] = [
  "read",
  "use",
  "update",
  "delete",
  "manage-permissions",
  "configure-deployment-spec",
];

const actionChipLabels: Record<ResourcePermissionAction, string> = {
  read: "View",
  use: "Use",
  update: "Edit",
  delete: "Delete",
  "manage-permissions": "Manage access",
  "configure-deployment-spec": "Deploy",
};
