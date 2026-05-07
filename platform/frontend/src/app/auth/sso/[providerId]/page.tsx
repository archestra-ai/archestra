"use client";

import { LINKED_IDP_SSO_MODE } from "@shared";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { createLinkedIdentityProviderIntent } from "@/lib/auth/linked-idp";
import { recordSsoSignInAttempt } from "@/lib/auth/sso-sign-in-attempt";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  getValidatedCallbackURLWithDefault,
  getValidatedRedirectPath,
} from "@/lib/utils/redirect-validation";

export default function IdpInitiatedSsoPage() {
  const params = useParams<{ providerId: string }>();
  const searchParams = useSearchParams();
  const hasStarted = useRef(false);
  const [failed, setFailed] = useState(false);

  const providerId = params.providerId;

  const startSso = useCallback(async () => {
    if (hasStarted.current) return;
    hasStarted.current = true;
    setFailed(false);

    const redirectTo = searchParams.get("redirectTo");
    const redirectPath = getValidatedRedirectPath(redirectTo);
    let callbackURL = getValidatedCallbackURLWithDefault(redirectTo);
    const isLinkedIdentityProviderFlow =
      searchParams.get("mode") === LINKED_IDP_SSO_MODE;

    try {
      if (isLinkedIdentityProviderFlow) {
        const intent = await createLinkedIdentityProviderIntent({
          providerId,
          redirectTo: redirectPath,
        });
        const callbackSearchParams = new URLSearchParams({
          intentId: intent.intentId,
          redirectTo: intent.redirectTo,
        });
        callbackURL = `${window.location.origin}/auth/sso/linked-callback?${callbackSearchParams.toString()}`;
      } else {
        recordSsoSignInAttempt(redirectPath);
      }

      await authClient.signIn.sso({
        providerId,
        callbackURL,
        errorCallbackURL: `${window.location.origin}/auth/sign-in`,
      });
    } catch {
      setFailed(true);
      toast.error("Failed to initiate SSO sign-in");
    }
  }, [providerId, searchParams]);

  useEffect(() => {
    startSso();
  }, [startSso]);

  const retrySso = useCallback(() => {
    hasStarted.current = false;
    startSso();
  }, [startSso]);

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
              <Button type="button" onClick={retrySso}>
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
