"use client";

import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

/**
 * The step bars at the top of a create dialog: one bar per step, filled up to
 * the current one. Valid steps can be visited directly, including earlier steps.
 */
export function WizardSteps<Id extends string>({
  steps,
  activeStep,
  onStepClick,
  canVisitStep,
}: {
  steps: Array<{ id: Id; title: string }>;
  activeStep: Id;
  onStepClick?: (step: Id) => void;
  canVisitStep?: (step: Id) => boolean;
}) {
  const activeIndex = steps.findIndex((step) => step.id === activeStep);
  return (
    <ol className="flex gap-2" aria-label="Steps">
      {steps.map((step, index) => {
        const reached = index <= activeIndex;
        const canVisit = canVisitStep
          ? canVisitStep(step.id)
          : index <= activeIndex;
        const content = (
          <>
            <span
              className={cn(
                "block h-[3px] rounded-full",
                reached ? "bg-primary" : "bg-border",
              )}
            />
            <span>
              {index + 1}. {step.title}
            </span>
          </>
        );
        return (
          <li
            key={step.id}
            aria-current={index === activeIndex ? "step" : undefined}
            className={cn(
              "flex flex-1 flex-col gap-1.5 text-xs",
              index === activeIndex
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {onStepClick ? (
              <UnstyledButton
                className="flex flex-col gap-1.5 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canVisit}
                onClick={() => onStepClick(step.id)}
              >
                {content}
              </UnstyledButton>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ol>
  );
}
