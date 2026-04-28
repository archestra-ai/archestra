"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AppLogo } from "@/components/app-logo";
import { LoadingSpinner } from "@/components/loading";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { recordSsoSignInAttempt } from "@/lib/auth/sso-sign-in-attempt";
import { authClient } from "@/lib/clients/auth/auth-client";
import { getValidatedCallbackURLWithDefault } from "@/lib/utils/redirect-validation";

export default function IdpInitiatedSsoPage() {
  const params = useParams<{ providerId: string }>();
  const searchParams = useSearchParams();
  const hasStarted = useRef(false);
  const [failed, setFailed] = useState(false);

  const providerId = params.providerId;

  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    const redirectTo = searchParams.get("redirectTo");
    const callbackURL = getValidatedCallbackURLWithDefault(redirectTo);

    recordSsoSignInAttempt();
    authClient.signIn
      .sso({
        providerId,
        callbackURL,
        errorCallbackURL: `${window.location.origin}/auth/sign-in`,
      })
      .catch(() => {
        setFailed(true);
        toast.error("Failed to initiate SSO sign-in");
      });
  }, [providerId, searchParams]);

  return (
    <main className="h-full flex items-center justify-center p-4">
      <div className="space-y-4 w-full max-w-md">
        <AppLogo />
        <Card>
          <CardHeader>
            <CardTitle>Redirecting to SSO</CardTitle>
            <CardDescription>
              Continue sign-in with your identity provider.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            {failed ? (
              <Button
                type="button"
                onClick={() => {
                  hasStarted.current = false;
                  setFailed(false);
                }}
              >
                Try Again
              </Button>
            ) : (
              <LoadingSpinner />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
