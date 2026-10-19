"use client";

import { type ReactNode, useId } from "react";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import { cn } from "@/lib/utils/tailwind";

export type AccessMode = "all" | "manual";

export interface AccessModeOption {
  title: string;
  /** What the list below the cards means in this mode. */
  rule: string;
  /** A short count, such as "3 disabled"; omitted while it is unknown. */
  stat?: string;
}

/**
 * The choice between "everything, minus what you exclude" and "only what you
 * pick". Each card states its rule, because the list below it changes meaning
 * with the mode: in All it blocks items, in Manual it allows them.
 */
export function AccessModeCards({
  label,
  mode,
  onModeChange,
  all,
  manual,
  readOnly = false,
  footnote,
}: {
  label: string;
  mode: AccessMode;
  onModeChange: (mode: AccessMode) => void;
  all: AccessModeOption;
  manual: AccessModeOption;
  /** Shows the current mode alone, with no way to switch. */
  readOnly?: boolean;
  footnote?: ReactNode;
}) {
  const baseId = useId();
  const current = mode === "all" ? all : manual;
  return (
    <div className="space-y-2">
      {readOnly ? (
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span className="font-medium">{current.title}</span>
            {current.stat && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {current.stat}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{current.rule}</p>
        </div>
      ) : (
        <RadioGroup
          aria-label={label}
          value={mode}
          onValueChange={(value) =>
            onModeChange(value === "all" ? "all" : "manual")
          }
          className="grid gap-2 sm:grid-cols-2"
        >
          <ModeCard id={`${baseId}-all`} value="all" option={all} />
          <ModeCard id={`${baseId}-manual`} value="manual" option={manual} />
        </RadioGroup>
      )}
      {footnote && (
        <div className="text-xs text-muted-foreground">{footnote}</div>
      )}
    </div>
  );
}

/** "Counting…", "None disabled", "3 disabled". */
export function accessModeCountStat(
  count: number | null,
  verb: string,
): string | undefined {
  if (count === null) return undefined;
  if (count === 0) return `None ${verb}`;
  return `${count.toLocaleString()} ${verb}`;
}

// ===

function ModeCard({
  id,
  value,
  option,
}: {
  id: string;
  value: AccessMode;
  option: AccessModeOption;
}) {
  // Named by the title alone and described by the count and rule, so a screen
  // reader does not read the card as one run-on word.
  const describedBy = option.stat ? `${id}-stat ${id}-rule` : `${id}-rule`;
  return (
    <label
      htmlFor={id}
      className={cn(
        radioCardClass(),
        "group flex cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2.5",
      )}
    >
      <RadioGroupItem
        id={id}
        value={value}
        aria-labelledby={`${id}-title`}
        aria-describedby={describedBy}
        className="mt-0.5"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span id={`${id}-title`} className="text-sm font-medium">
            {option.title}
          </span>
          {option.stat && (
            <span
              id={`${id}-stat`}
              className="shrink-0 text-xs tabular-nums text-muted-foreground group-has-[[data-state=checked]]:font-medium group-has-[[data-state=checked]]:text-foreground"
            >
              {option.stat}
            </span>
          )}
        </span>
        <span
          id={`${id}-rule`}
          className="mt-0.5 block text-xs text-muted-foreground"
        >
          {option.rule}
        </span>
      </span>
    </label>
  );
}
