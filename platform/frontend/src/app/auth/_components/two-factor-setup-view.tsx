"use client";

import { useSearchParams } from "next/navigation";
import { useTwoFactorEnrollment } from "@/components/two-factor/two-factor-enrollment";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useSession } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { getValidatedRedirectPath } from "@/lib/utils/redirect-validation";

/**
 * Full-page enrollment, used when the organization mandates 2FA: the API's
 * `two_factor_setup_required` refusal routes here and the member keeps
 * landing here until enrolled. The account page runs the same flow in a
 * dialog instead of sending people into /auth.
 */
export function TwoFactorSetupView() {
  const searchParams = useSearchParams();
  const redirectTo = getValidatedRedirectPath(searchParams.get("redirectTo"));
  const { data: session } = useSession();
  const { data: organization } = useOrganization();

  const { step, title, description, body } = useTwoFactorEnrollment({
    requiredByOrganization: !!organization?.requireTwoFactor,
    showSwitchUserLink: true,
    // Full navigation so the app re-reads the now-enrolled session.
    onFinished: () => window.location.assign(redirectTo),
  });

  // Already enrolled and not mid-flow: nothing to set up here. Verifying the
  // first code flips this flag while the wizard still has recovery codes to
  // show, so this must only fire before the flow starts.
  if (session?.user.twoFactorEnabled && step === "password") {
    window.location.assign(redirectTo);
    return null;
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
