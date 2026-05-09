"use client";

import { useSearchParams } from "next/navigation";
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
import { completeLinkedIdentityProviderIntent } from "@/lib/auth/linked-idp";
import { getValidatedRedirectPath } from "@/lib/utils/redirect-validation";

export default function LinkedIdentityProviderCallbackPage() {
  const searchParams = useSearchParams();
  const hasStarted = useRef(false);
  const [failed, setFailed] = useState(false);

  const completeLink = useCallback(async () => {
    if (hasStarted.current) return;
    hasStarted.current = true;
    setFailed(false);

    const intentId = searchParams.get("intentId");
    const fallbackRedirectPath = getValidatedRedirectPath(
      searchParams.get("redirectTo"),
    );

    if (!intentId) {
      setFailed(true);
      toast.error("Missing identity provider link request");
      return;
    }

    try {
      const result = await completeLinkedIdentityProviderIntent(intentId);
      const redirectPath = result.redirectTo
        ? getValidatedRedirectPath(result.redirectTo)
        : fallbackRedirectPath;
      window.location.replace(appendUserPrompt(redirectPath, "retry"));
    } catch {
      setFailed(true);
      toast.error("Failed to complete identity provider connection");
    }
  }, [searchParams]);

  useEffect(() => {
    completeLink();
  }, [completeLink]);

  const retry = useCallback(() => {
    hasStarted.current = false;
    completeLink();
  }, [completeLink]);

  return (
    <main className="h-full flex items-center justify-center p-4">
      <div className="space-y-4 w-full max-w-md">
        <AppLogo />
        <Card>
          <CardHeader>
            <CardTitle>Connecting identity provider</CardTitle>
            <CardDescription>
              Finishing the identity provider connection.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            {failed ? (
              <Button type="button" onClick={retry}>
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

function appendUserPrompt(path: string, prompt: string) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("user_prompt", prompt);
  return `${url.pathname}${url.search}${url.hash}`;
}
