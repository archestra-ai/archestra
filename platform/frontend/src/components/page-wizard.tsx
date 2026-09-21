"use client";

import type { ReactNode } from "react";
import { PageLayout } from "@/components/page-layout";
import {
  type WizardStepDefinition,
  WizardStepper,
} from "@/components/wizard-stepper";

/**
 * Shared page shell for substantial create and setup forms.
 *
 * The shell owns only the page presentation. Forms stay in the caller so a
 * footer can submit the native form element and the caller can keep its draft,
 * validation, dirty state, and mutations in one place.
 */
export function PageWizard<Id extends string>({
  title,
  description,
  documentTitle,
  backLink,
  steps,
  activeStep,
  onStepClick,
  stepTestIdPrefix,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  documentTitle?: string;
  backLink?: ReactNode;
  steps?: readonly WizardStepDefinition<Id>[];
  activeStep?: Id;
  onStepClick?: (step: Id) => void;
  stepTestIdPrefix?: string;
  children: ReactNode;
}) {
  const showStepper = !!steps && steps.length > 1 && activeStep !== undefined;

  return (
    <PageLayout
      maxWidth="wizard"
      minWidth="phone"
      contentOverflowX="clip"
      title={title}
      description={description}
      documentTitle={documentTitle}
      backLink={backLink}
      actionButton={
        showStepper ? (
          <WizardStepper
            compact
            steps={steps}
            activeStep={activeStep}
            onStepClick={onStepClick}
            stepTestIdPrefix={stepTestIdPrefix}
          />
        ) : undefined
      }
    >
      {children}
    </PageLayout>
  );
}
