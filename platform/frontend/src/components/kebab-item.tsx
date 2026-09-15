"use client";

import { useId } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

export function KebabItem({
  icon,
  label,
  reason,
  isBusy,
  variant,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  reason?: string;
  /** Permitted, but already running: taking it again would export twice. */
  isBusy?: boolean;
  variant?: "destructive";
  onSelect: () => void;
}) {
  const reasonId = useId();
  const isDisabled = !!reason || !!isBusy;

  return (
    <DropdownMenuItem
      variant={variant}
      aria-disabled={isDisabled || undefined}
      aria-describedby={reason ? reasonId : undefined}
      className={isDisabled ? "cursor-not-allowed opacity-50" : undefined}
      onSelect={(event) => {
        if (isDisabled) event.preventDefault();
      }}
      onClick={(event) => {
        if (isDisabled) {
          event.preventDefault();
          return;
        }
        onSelect();
      }}
    >
      {icon}
      {label}
      {/* The reason as text, not only as a tooltip: a menu item reached by
          keyboard never opens one. `aria-hidden` keeps it out of the accessible
          name, where it would duplicate the description a screen reader already
          reads from `aria-describedby`. */}
      {reason && (
        <span id={reasonId} aria-hidden="true" className="sr-only">
          {reason}
        </span>
      )}
    </DropdownMenuItem>
  );
}
