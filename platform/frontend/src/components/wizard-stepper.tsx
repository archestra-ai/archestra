"use client";

import { Check, ChevronRight } from "lucide-react";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

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
  compact = false,
  variant = "numbered",
}: {
  steps: ReadonlyArray<WizardStepDefinition<Id>>;
  activeStep: Id;
  onStepClick?: (step: Id) => void;
  /** When set, each step button gets `data-testid="<prefix>-<step id>"`. */
  stepTestIdPrefix?: string;
  /** Compact header mode: keep labels only where the header has room. */
  compact?: boolean;
  /**
   * `progress` draws one segment per step with its name under it, and on a
   * phone collapses to "Step n of m" over the bare segments.
   */
  variant?: "numbered" | "progress";
}) {
  const activeIndex = steps.findIndex((s) => s.id === activeStep);
  if (variant === "progress") {
    const active = steps[activeIndex];
    return (
      <nav
        aria-label="Progress"
        className="w-full min-w-0 sm:w-[min(42rem,55vw)]"
      >
        <p className="mb-2 truncate text-xs text-muted-foreground sm:hidden">
          <span className="font-medium text-foreground">
            Step {activeIndex + 1} of {steps.length}
          </span>
          <span> · {active?.title}</span>
        </p>
        <ol
          className="grid gap-2 sm:gap-3"
          style={{
            gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
          }}
        >
          {steps.map((step, index) => {
            const isActive = index === activeIndex;
            const isComplete = index < activeIndex;
            const state = isActive
              ? "current"
              : isComplete
                ? "complete"
                : "upcoming";
            return (
              <li key={step.id} className="min-w-0">
                <UnstyledButton
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 flex-col gap-2 py-1 text-left",
                    onStepClick ? "cursor-pointer" : "cursor-default",
                  )}
                  aria-label={`Step ${index + 1} of ${steps.length}: ${step.title}, ${state}`}
                  title={step.title}
                  aria-current={isActive ? "step" : undefined}
                  data-testid={
                    stepTestIdPrefix
                      ? `${stepTestIdPrefix}-${step.id}`
                      : undefined
                  }
                  onClick={() => onStepClick?.(step.id)}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-1 w-full rounded-full transition-colors",
                      isActive
                        ? "bg-primary"
                        : isComplete
                          ? "bg-primary/40"
                          : "bg-border",
                    )}
                  />
                  <span
                    className={cn(
                      "hidden truncate text-xs sm:block",
                      isActive
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {index + 1} · {step.title}
                  </span>
                </UnstyledButton>
              </li>
            );
          })}
        </ol>
      </nav>
    );
  }
  return (
    <ol
      className={cn("flex items-center", compact ? "gap-2" : "flex-wrap gap-3")}
    >
      {steps.map((step, index) => {
        const isActive = index === activeIndex;
        const isComplete = index < activeIndex;
        const state = isActive
          ? "current"
          : isComplete
            ? "complete"
            : "upcoming";
        return (
          <li
            key={step.id}
            className={cn("flex items-center", compact ? "gap-2" : "gap-3")}
          >
            <UnstyledButton
              type="button"
              className={cn(
                "flex items-center gap-2",
                onStepClick ? "cursor-pointer" : "cursor-default",
              )}
              aria-label={`Step ${index + 1} of ${steps.length}: ${step.title}, ${state}`}
              title={step.title}
              aria-current={isActive ? "step" : undefined}
              data-testid={
                stepTestIdPrefix ? `${stepTestIdPrefix}-${step.id}` : undefined
              }
              onClick={() => onStepClick?.(step.id)}
            >
              <span
                className={cn(
                  "flex items-center justify-center rounded-full border text-xs font-medium",
                  compact ? "h-9 w-9 sm:h-6 sm:w-6" : "h-6 w-6",
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
                  compact && !isActive && "hidden xl:inline",
                  isActive ? "font-medium" : "text-muted-foreground",
                )}
              >
                {step.title}
              </span>
            </UnstyledButton>
            {index < steps.length - 1 && (
              <span
                data-step-connector-state={isComplete ? "complete" : "upcoming"}
                className={cn(
                  "relative h-px transition-colors",
                  isComplete ? "bg-primary" : "bg-border",
                  compact ? "w-4 xl:w-8" : "w-8",
                )}
                aria-hidden="true"
              >
                <ChevronRight
                  className={cn(
                    "absolute -right-1.5 top-1/2 size-3 -translate-y-1/2 stroke-[2.5]",
                    isComplete ? "text-primary" : "text-muted-foreground",
                  )}
                />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
