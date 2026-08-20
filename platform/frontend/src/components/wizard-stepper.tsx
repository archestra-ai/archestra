"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface WizardStepDefinition<Id extends string> {
  id: Id;
  title: string;
}

/**
 * Horizontal numbered stepper for multi-step create/edit flows: completed steps
 * show a check, the active one is filled, later ones are muted. Steps are only
 * clickable when `onStepClick` is passed — a create flow that has nothing to
 * navigate back to renders it static.
 */
export function WizardStepper<Id extends string>({
  steps,
  activeStep,
  onStepClick,
  stepTestIdPrefix,
}: {
  steps: ReadonlyArray<WizardStepDefinition<Id>>;
  activeStep: Id;
  onStepClick?: (step: Id) => void;
  /** When set, each step button gets `data-testid="<prefix>-<step id>"`. */
  stepTestIdPrefix?: string;
}) {
  const activeIndex = steps.findIndex((s) => s.id === activeStep);
  return (
    <ol className="flex flex-wrap items-center gap-3">
      {steps.map((step, index) => {
        const isActive = index === activeIndex;
        const isComplete = index < activeIndex;
        return (
          <li key={step.id} className="flex items-center gap-3">
            <button
              type="button"
              className={cn(
                "flex items-center gap-2",
                onStepClick ? "cursor-pointer" : "cursor-default",
              )}
              aria-current={isActive ? "step" : undefined}
              data-testid={
                stepTestIdPrefix ? `${stepTestIdPrefix}-${step.id}` : undefined
              }
              onClick={() => onStepClick?.(step.id)}
            >
              <span
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full border text-xs font-medium",
                  isActive &&
                    "border-primary bg-primary text-primary-foreground",
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
            </button>
            {index < steps.length - 1 && (
              <span className="h-px w-8 bg-border" aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
