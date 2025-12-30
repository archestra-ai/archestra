"use client";

import { AlternativeOnboardingDialog } from "@/components/alternative-onboarding-dialog";
import { useOrganization } from "@/lib/organization.query";

export function OnboardingDialogWrapper() {
  const { data: organization } = useOrganization();

  if (!organization) {
    return null;
  }

  return (
    <AlternativeOnboardingDialog open={!organization?.onboardingComplete} />
  );
}
