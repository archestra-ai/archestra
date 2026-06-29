"use client";

import { BookOpen } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { OnboardingWizardDialogWizard } from "./onboarding-wizard-dialog";
import { OnboardingWizardDialog } from "./onboarding-wizard-dialog";

interface OnboardingWizardButtonProps {
  wizard: OnboardingWizardDialogWizard;
}

export function OnboardingWizardButton({
  wizard,
}: OnboardingWizardButtonProps) {
  const [open, setOpen] = useState(false);
  const label = wizard.label?.trim() || "Open wizard";

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={() => setOpen(true)}
      >
        <BookOpen className="h-4 w-4" />
        {label}
      </Button>
      <OnboardingWizardDialog
        mode="runtime"
        open={open}
        onOpenChange={setOpen}
        wizard={wizard}
      />
    </>
  );
}
