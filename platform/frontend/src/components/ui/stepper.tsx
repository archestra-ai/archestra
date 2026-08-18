"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StepperStep<TId extends string = string> {
  id: TId;
  title: string;
}

/**
 * Horizontal progress indicator for a multi-step setup flow.
 *
 * Steps are only interactive when `onStepClick` is supplied — a read-only
 * stepper renders plain text rather than disabled buttons, so it doesn't put
 * dead tab stops between the user and the form they're trying to fill in.
 */
export function Stepper<TId extends string>({
  steps,
  activeStep,
  onStepClick,
  className,
}: {
  steps: ReadonlyArray<StepperStep<TId>>;
  activeStep: TId;
  onStepClick?: (step: TId) => void;
  className?: string;
}) {
  const activeIndex = steps.findIndex((step) => step.id === activeStep);

  return (
    <ol className={cn("flex flex-wrap items-center gap-3", className)}>
      {steps.map((step, index) => {
        const isActive = index === activeIndex;
        const isComplete = index < activeIndex;
        const content = (
          <>
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border font-medium text-xs",
                isActive && "border-primary bg-primary text-primary-foreground",
                isComplete && "border-primary bg-primary/10 text-primary",
                !isActive && !isComplete && "text-muted-foreground",
              )}
            >
              {isComplete ? <Check className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <span
              className={cn(
                "text-sm",
                isActive ? "font-medium" : "text-muted-foreground",
              )}
            >
              {step.title}
            </span>
          </>
        );

        return (
          <li
            key={step.id}
            className="flex items-center gap-3"
            aria-current={isActive ? "step" : undefined}
          >
            {onStepClick ? (
              <button
                type="button"
                className="flex cursor-pointer items-center gap-2"
                onClick={() => onStepClick(step.id)}
              >
                {content}
              </button>
            ) : (
              <span className="flex items-center gap-2">{content}</span>
            )}
            {index < steps.length - 1 && (
              <span className="h-px w-8 bg-border" aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
