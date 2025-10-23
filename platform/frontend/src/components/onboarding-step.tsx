import type { ReactNode } from "react";
import { Button } from "./ui/button";

interface OnboardingStepProps {
  /** The step title */
  title: string;
  /** Optional description text or React element */
  description?: ReactNode;
  /** Main content of the step */
  children?: ReactNode;
  /** Optional primary action button */
  primaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
  /** Whether this step is currently active */
  isActive: boolean;
  /** Whether a transition is in progress */
  isTransitioning: boolean;
}

/**
 * OnboardingStep component
 * Reusable step card with consistent styling and animations
 */
export default function OnboardingStep({
  title,
  description,
  children,
  primaryAction,
  isActive,
  isTransitioning,
}: OnboardingStepProps) {
  const baseClasses = isActive
    ? "bg-black p-8 transition-all duration-300 ease-in-out rounded-md border border-slate-800"
    : "bg-black p-4 transition-all duration-300 ease-in-out rounded-md ";

  const greyedClasses = !isActive ? "opacity-40" : "";

  const transitionClasses = isTransitioning
    ? "scale-95 opacity-50"
    : "scale-100 opacity-100";

  const activeTransitionClasses = isActive ? transitionClasses : "";

  return (
    <div
      className={`${baseClasses} ${greyedClasses} ${activeTransitionClasses}`}
    >
      <h3 className="mb-3 text-base font-medium text-white">{title}</h3>

      {description && (
        <p
          className={`text-sm text-slate-300 ${isActive && (children || primaryAction) ? "mb-6" : ""}`}
        >
          {description}
        </p>
      )}

      {isActive && children && <div className="space-y-4">{children}</div>}

      {isActive && primaryAction && (
        <Button
          type="button"
          onClick={primaryAction.onClick}
          disabled={primaryAction.disabled}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white py-3 px-4 rounded font-medium transition-colors mt-6"
        >
          {primaryAction.label}
        </Button>
      )}
    </div>
  );
}

export type { OnboardingStepProps };
