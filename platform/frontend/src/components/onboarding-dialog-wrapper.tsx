"use client";

import { OnboardingDialog } from "@/components/onboarding-dialog";
import { useOrganization } from "@/lib/organization.query";

export function OnboardingDialogWrapper() {
  const { data: organization } = useOrganization();

  if (!organization) {
    return null;
  }

  return <OnboardingDialog open={!organization?.onboardingComplete} />;
}
