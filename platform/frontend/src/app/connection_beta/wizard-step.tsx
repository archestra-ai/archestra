"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface WizardStepProps {
  n: number;
  title: string;
  /** Last step: no connector line below the number. */
  last?: boolean;
  /** Right-aligned controls in the title row (e.g. a gateway picker). */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * One entry of the vertical wizard rail: a numbered circle on the left, a
 * connector line down to the next step, and the step body on the right.
 * Steps stack directly under each other (no gaps) so the rail reads as one
 * continuous line.
 */
export function WizardStep({
  n,
  title,
  last = false,
  actions,
  children,
}: WizardStepProps) {
  return (
    <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-4">
      <div className="flex flex-col items-center">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary font-mono text-[13px] font-bold text-primary-foreground">
          {n}
        </div>
        {!last && <div className="w-px flex-1 bg-border" />}
      </div>
      <div className={cn("min-w-0", !last && "pb-8")}>
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
          <h3 className="text-[17px] font-bold tracking-tight text-foreground">
            {title}
          </h3>
          {actions}
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
