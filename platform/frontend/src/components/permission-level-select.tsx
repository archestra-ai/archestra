// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils/tailwind";

export type PermissionLevelOption = {
  value: string;
  label: string;
  description: string;
  disabled?: boolean;
};

/**
 * The one dropdown for choosing what a recipient can do. Every place that
 * grants access renders it, so each level always reads with its description
 * and no picker shows less than another.
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
  className?: string;
}) {
  return (
    <Select disabled={disabled} value={value} onValueChange={onValueChange}>
      <SelectTrigger
        size="sm"
        // Sized to fit the longest level ("Full access + deployment") so the
        // label is never cut off, and the same width in every list.
        className={cn("w-56 shrink-0 text-left", className)}
        aria-label={ariaLabel}
        title={title}
      >
        <SelectValue>
          {valueLabel ??
            options.find((option) => option.value === value)?.label}
        </SelectValue>
      </SelectTrigger>
      {/* Wide enough for the descriptions to stay on one line. */}
      <SelectContent className="max-w-[min(26rem,calc(100vw-2rem))]">
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            description={option.description}
            className="py-2"
          >
            <span className="font-medium">{option.label}</span>
          </SelectItem>
        ))}
        {extraOption && (
          <SelectItem value={extraOption.value} disabled>
            {extraOption.label}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
