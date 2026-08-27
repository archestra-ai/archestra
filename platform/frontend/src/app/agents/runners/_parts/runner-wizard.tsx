"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import {
  RunnerAccessFields,
  RunnerConfigurationFields,
  RunnerExecutionFields,
  type RunnerFormState,
} from "./runner-form";

type RunnerStep = "configuration" | "execution" | "access";

const STEPS: Array<{ id: RunnerStep; title: string }> = [
  { id: "configuration", title: "Configuration" },
  { id: "execution", title: "Execution" },
  { id: "access", title: "Access" },
];

const STEP_DESCRIPTIONS: Record<RunnerStep, string> = {
  configuration: "Name the runner and choose the image sessions run in.",
  execution: "How a session is steered, and which environment it runs under.",
  access: "Label the runner and declare the credentials a session needs.",
};

/** The page header's way back: to the list, or from the wizard to the runner. */
export function RunnerBackLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 text-muted-foreground"
      asChild
    >
      <Link href={href}>
        <ArrowLeft className="h-4 w-4" />
        {label}
      </Link>
    </Button>
  );
}

/**
 * The create and edit flows differ only in their title, their way back and
 * what saving does, so they share one wizard rather than two that drift.
 */
export function RunnerWizard({
  title,
  backHref,
  backLabel,
  form,
  submitLabel,
  isSaving,
  onSubmit,
}: {
  title: string;
  backHref: string;
  backLabel: string;
  form: RunnerFormState;
  submitLabel: string;
  isSaving: boolean;
  onSubmit: () => void;
}) {
  const [step, setStep] = useState<RunnerStep>("configuration");
  const stepIndex = STEPS.findIndex((entry) => entry.id === step);
  const isLastStep = stepIndex === STEPS.length - 1;

  return (
    <PageLayout
      title={title}
      description={STEP_DESCRIPTIONS[step]}
      backLink={<RunnerBackLink href={backHref} label={backLabel} />}
      maxWidth="wizard"
    >
      <div className="space-y-6">
        <WizardStepper
          steps={STEPS}
          activeStep={step}
          // Only steps already passed are reachable from the stepper; Continue
          // is the way forward, so a step cannot be skipped over.
          onStepClick={(target) => {
            const targetIndex = STEPS.findIndex((entry) => entry.id === target);
            if (targetIndex < stepIndex) setStep(target);
          }}
        />

        <div className="mx-auto w-full max-w-3xl">
          {step === "configuration" && (
            <RunnerConfigurationFields form={form} />
          )}
          {step === "execution" && <RunnerExecutionFields form={form} />}
          {step === "access" && <RunnerAccessFields form={form} />}

          <WizardFooter>
            {stepIndex > 0 ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep(STEPS[stepIndex - 1].id)}
              >
                Back
              </Button>
            ) : (
              <span />
            )}
            {isLastStep ? (
              <Button
                type="button"
                disabled={isSaving || !form.canContinue}
                onClick={onSubmit}
              >
                {isSaving ? "Saving..." : submitLabel}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={!form.canContinue}
                onClick={() => setStep(STEPS[stepIndex + 1].id)}
              >
                Continue
              </Button>
            )}
          </WizardFooter>
        </div>
      </div>
    </PageLayout>
  );
}
