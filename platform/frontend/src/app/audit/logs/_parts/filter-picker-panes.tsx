"use client";

import { Check, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import { auditResourceIcon } from "./audit-event-taxonomy";

// Shared pieces of the audit log's two-pane filter pickers (Event, Actor):
// rows marked with `data-nav` so arrow keys move within a pane.

/** Height of each pane, leaving room for the search row above it. */
export const PICKER_PANE_HEIGHT =
  "h-[min(22rem,calc(var(--radix-popover-content-available-height)-2.75rem))]";

export const PICKER_ROW_CLASS =
  "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground";

export function PickerRow({
  nav,
  selected,
  hint,
  onClick,
  className,
  children,
  leading,
  description,
}: {
  nav: string;
  selected: boolean;
  /** The raw event name, for people who know the trail by its keys. */
  hint?: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
  /** Leading icon or avatar. */
  leading?: ReactNode;
  /** Second line under the label. */
  description?: string | null;
}) {
  return (
    <UnstyledButton
      data-nav={nav}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(PICKER_ROW_CLASS, selected && "bg-accent/50", className)}
    >
      {leading}
      {description ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate leading-5">{children}</span>
          <span className="block truncate text-xs leading-4 text-muted-foreground">
            {description}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{children}</span>
      )}
      {hint ? (
        <span className="hidden max-w-[45%] shrink truncate font-mono text-[11px] text-muted-foreground sm:block">
          {hint}
        </span>
      ) : null}
      <Check
        aria-hidden
        className={cn(
          "size-4 shrink-0",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
    </UnstyledButton>
  );
}

export function PickerTile({
  type,
  icon,
}: {
  type?: string;
  icon?: LucideIcon;
}) {
  const Icon = icon ?? auditResourceIcon(type);
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-gradient-to-b from-background to-muted/70 text-foreground/70">
      <Icon aria-hidden className="size-4" />
    </span>
  );
}

export function focusFirstPickerRow(root: HTMLElement | null, group: string) {
  root?.querySelector<HTMLElement>(`[data-nav="${group}"]`)?.focus();
}

export function movePickerFocus({
  root,
  group,
  from,
  delta,
}: {
  root: HTMLElement | null;
  group: string;
  from: HTMLElement;
  delta: number;
}): boolean {
  if (!root) return false;
  const items = Array.from(
    root.querySelectorAll<HTMLElement>(`[data-nav="${group}"]`),
  );
  const next = items[items.indexOf(from) + delta];
  if (!next) return false;
  next.focus();
  next.scrollIntoView({ block: "nearest" });
  return true;
}
