// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  ENVIRONMENT_DEPLOY_KIND_LABELS,
  ENVIRONMENT_DEPLOY_KINDS,
  type EnvironmentDeployKind,
} from "@archestra/shared";
import { Check, ChevronDown } from "lucide-react";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import {
  type PermissionLevelOption,
  permissionLevelIcon,
} from "@/components/permission-level-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

/**
 * What a recipient can do with an environment, in one list. "Can use" is the
 * level that deploys; while it is chosen, the kinds of object it covers sit
 * beneath it, all checked unless the grant is narrowed to some of them.
 */
export function EnvironmentAccessSelect({
  rowKey,
  name,
  level,
  options,
  onLevelChange,
  kinds,
  onKindsChange,
  grantableKinds,
  disabled,
  open,
  onOpenChange,
}: {
  /** Stable per recipient: what the open list remembers across a remount. */
  rowKey: string;
  /** The recipient's display name, for labels. */
  name: string;
  /** The chosen option's value, or `USE` when the grant is narrowed. */
  level: string;
  options: PermissionLevelOption[];
  onLevelChange: (level: string) => void;
  /** The kinds deployable now. Only read while the level is `USE`. */
  kinds: readonly EnvironmentDeployKind[];
  /** Never called with no kinds: that is a read-only level. */
  onKindsChange: (kinds: EnvironmentDeployKind[]) => void;
  /** The kinds the viewer may hand on. A kind outside it can only be cleared. */
  grantableKinds: readonly EnvironmentDeployKind[];
  disabled?: boolean;
  /**
   * Held by the caller: a grant row is rebuilt when its actions change, and
   * the list has to stay open across that so several kinds take one visit.
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // A mount that starts open is a rebuilt row, so it skips the entrance
  // animation and puts focus back where it was.
  const [mountedOpen] = useState(open);
  const contentRef = useRef<HTMLDivElement>(null);
  const kindIdPrefix = useId();

  const total = ENVIRONMENT_DEPLOY_KINDS.length;
  const deploys = level === ENVIRONMENT_USE_LEVEL;
  const narrowed = deploys && kinds.length < total;
  const selected = options.find((option) => option.value === level);

  const setOpen = (next: boolean) => {
    if (!next) memory = { rowKey: null, focus: null };
    onOpenChange(next);
  };

  const chooseLevel = (option: PermissionLevelOption) => {
    if (option.value === level) {
      // Choosing "Can use" again never drops the kinds it is narrowed to.
      setOpen(false);
      return;
    }
    if (option.value === ENVIRONMENT_USE_LEVEL) {
      // Stays open so the kinds it now covers are in view.
      memory = { rowKey, focus: focusKey.level(option.value) };
      onLevelChange(option.value);
      return;
    }
    onLevelChange(option.value);
    setOpen(false);
  };

  const toggleKind = (kind: EnvironmentDeployKind, checked: boolean) => {
    const next = ENVIRONMENT_DEPLOY_KINDS.filter((candidate) =>
      candidate === kind ? checked : kinds.includes(candidate),
    );
    if (next.length === 0) return;
    memory = { rowKey, focus: focusKey.kind(kind) };
    onKindsChange(next);
  };

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>(
        "[data-level-row]:not(:disabled)",
      ) ?? [],
    );
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    rows[(at + step + rows.length) % rows.length]?.focus();
  };

  const kindsSummary = deployKindsSummary(kinds);
  const label = selected?.label ?? "Custom";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          aria-label={`Permission for ${name}`}
          title={narrowed ? `${label}: ${kindsSummary}` : selected?.description}
          className="h-11 min-h-11 max-w-44 gap-1 px-2 text-[13px] font-normal sm:h-7 sm:min-h-7 sm:max-w-64"
        >
          <span className="truncate">
            {label}
            {narrowed && (
              <span className="text-muted-foreground">
                {" · "}
                {/* A narrow row has room for the count, not the names. */}
                <span className="hidden sm:inline">
                  {kinds.length <= 2
                    ? kindsSummary
                    : `${kinds.length} of ${total} kinds`}
                </span>
                <span className="sm:hidden">
                  {kinds.length} of {total}
                </span>
              </span>
            )}
          </span>
          <ChevronDown
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="end"
        collisionPadding={8}
        className={cn(
          "max-h-(--radix-popover-content-available-height) w-[min(24rem,calc(100vw-1rem))] overflow-y-auto p-1",
          mountedOpen && "!animate-none",
        )}
        onKeyDown={moveFocus}
        onOpenAutoFocus={(event) => {
          const wanted =
            mountedOpen && memory.rowKey === rowKey && memory.focus
              ? `[data-focus-key="${memory.focus}"]`
              : '[data-level-row][aria-checked="true"]';
          const target = contentRef.current?.querySelector<HTMLElement>(wanted);
          if (!target) return;
          event.preventDefault();
          target.focus({ preventScroll: mountedOpen });
        }}
      >
        <div role="radiogroup" aria-label={`Permission for ${name}`}>
          {options.map((option) => {
            const Icon = permissionLevelIcon(option);
            const isSelected = option.value === level;
            return (
              <div key={option.value}>
                <UnstyledButton
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={option.label}
                  data-level-row=""
                  data-focus-key={focusKey.level(option.value)}
                  disabled={option.disabled}
                  onClick={() => chooseLevel(option)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-sm px-2 py-1.5 text-left outline-none",
                    "hover:bg-accent focus-visible:bg-accent",
                    "disabled:pointer-events-none disabled:opacity-50",
                  )}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      isSelected ? "text-foreground" : "text-muted-foreground",
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] leading-5 font-medium">
                      {option.label}
                    </span>
                    <span className="block text-xs leading-4 text-pretty text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                  <Check
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      !isSelected && "invisible",
                    )}
                    aria-hidden="true"
                  />
                </UnstyledButton>
                {isSelected && option.value === ENVIRONMENT_USE_LEVEL && (
                  // The rule drops from the centre of the row's icon, and the
                  // caption and checkboxes line up under its label.
                  <fieldset
                    aria-label={`Kinds ${name} can deploy`}
                    className="mt-0.5 mb-1.5 ml-4 min-w-0 border-l py-1 pr-2 pl-[17px]"
                  >
                    <div className="flex h-5 items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span>Can deploy</span>
                      <span className="tabular-nums">
                        {narrowed ? `${kinds.length} of ${total}` : "All"}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                      {ENVIRONMENT_DEPLOY_KINDS.map((kind) => {
                        const checked = kinds.includes(kind);
                        const last = checked && kinds.length === 1;
                        const ungrantable = !grantableKinds.includes(kind);
                        const off = disabled || (checked ? last : ungrantable);
                        return (
                          <label
                            key={kind}
                            htmlFor={`${kindIdPrefix}-${kind}`}
                            title={kindHint({ checked, last, ungrantable })}
                            className={cn(
                              "flex min-h-6 min-w-0 items-center gap-2 text-xs",
                              off
                                ? "cursor-not-allowed text-muted-foreground"
                                : "cursor-pointer",
                            )}
                          >
                            <Checkbox
                              id={`${kindIdPrefix}-${kind}`}
                              checked={checked}
                              disabled={off}
                              data-focus-key={focusKey.kind(kind)}
                              onCheckedChange={(next) =>
                                toggleKind(kind, next === true)
                              }
                              className="size-3.5 shrink-0 [&_svg]:size-3"
                            />
                            <span className="min-w-0 leading-4">
                              {ENVIRONMENT_DEPLOY_KIND_LABELS[kind]}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                )}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The level that deploys: every kind, or the kinds a grant is narrowed to. */
export const ENVIRONMENT_USE_LEVEL = "use";

/** The kinds by name, in the order the list shows them. */
export function deployKindsSummary(
  kinds: readonly EnvironmentDeployKind[],
): string {
  return ENVIRONMENT_DEPLOY_KINDS.filter((kind) => kinds.includes(kind))
    .map((kind) => ENVIRONMENT_DEPLOY_KIND_LABELS[kind])
    .join(", ");
}

// ===

const focusKey = {
  level: (value: string) => `level:${value}`,
  kind: (kind: EnvironmentDeployKind) => `kind:${kind}`,
};

// What the open list carries across a rebuild of its row: which control had
// focus, for which recipient.
let memory: { rowKey: string | null; focus: string | null } = {
  rowKey: null,
  focus: null,
};

function kindHint({
  checked,
  last,
  ungrantable,
}: {
  checked: boolean;
  last: boolean;
  ungrantable: boolean;
}): string | undefined {
  if (last)
    return "A grant deploys at least one kind. Choose a read-only level for none.";
  if (!ungrantable) return undefined;
  return checked
    ? "You can clear this kind, but not grant it again."
    : "You cannot grant this kind.";
}
