"use client";

import { cn } from "@/lib/utils";

interface StepIndicatorProps {
  steps: string[];
  currentStep: number;
}

export default function StepIndicator({
  steps,
  currentStep,
}: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-center gap-3">
      {steps.map((label, index) => (
        <div key={`step-${label}`} className="flex items-center">
          <div
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all",
              index === currentStep
                ? "bg-blue-600 text-white shadow-lg"
                : index < currentStep
                  ? "bg-blue-600 text-white"
                  : "bg-slate-700 text-slate-400",
            )}
          >
            {index + 1}
          </div>
          {index < steps.length - 1 && (
            <div
              className={cn(
                "h-1 w-8 mx-1 transition-all",
                index < currentStep ? "bg-blue-600" : "bg-slate-700",
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}
