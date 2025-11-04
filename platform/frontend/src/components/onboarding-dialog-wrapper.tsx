"use client";

import { archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { OnboardingDialog } from "@/components/onboarding-dialog";
import { authClient } from "@/lib/clients/auth/auth-client";
import { organizationKeys } from "@/lib/organization.query";

export function OnboardingDialogWrapper() {
  const session = authClient.useSession();

  // Only fetch organization details when authenticated
  const { data: organization } = useQuery({
    queryKey: organizationKeys.details(),
    queryFn: async () => {
      const response = await archestraApiSdk.getOrganization();
      return response.data;
    },
    enabled: !!session.data?.user, // Only run when user is authenticated
  });

  // Only show on authenticated pages
  if (!session.data?.user) {
    return null;
  }

  // Show dialog if onboarding is not complete
  const showDialog = organization && !organization.onboardingComplete;

  return <OnboardingDialog open={!!showDialog} />;
}
