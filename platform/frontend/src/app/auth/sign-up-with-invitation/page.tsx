"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useInvitationCheck } from "@/lib/invitation.query";
import { useAcceptInvitation } from "@/lib/organization.query";

function SignUpWithInvitationContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [hasProcessed, setHasProcessed] = useState(false);

  const invitationId = searchParams.get("invitationId");
  const email = searchParams.get("email");

  const { data: session } = authClient.useSession();
  const acceptMutation = useAcceptInvitation();
  const { data: invitationData, isLoading: isCheckingInvitation } =
    useInvitationCheck(invitationId);

  // Redirect existing users to sign-in
  useEffect(() => {
    if (invitationId && invitationData?.userExists) {
      router.push(`/auth/sign-in?invitationId=${invitationId}`);
    }
  }, [invitationId, invitationData, router]);

  // Handle auto-accept after sign-up
  // biome-ignore lint/correctness/useExhaustiveDependencies: acceptMutation object changes reference on every render. Using the stable mutateAsync function reference prevents unnecessary re-executions.
  useEffect(() => {
    // Only process if we've done initial check and now have a new session
    if (session && invitationId && !hasProcessed) {
      setHasProcessed(true);
      acceptMutation.mutateAsync(invitationId);
    }
  }, [session, invitationId, hasProcessed, acceptMutation.mutateAsync]);

  // Prefill email field (but keep it editable for form validation)
  useEffect(() => {
    if (!email) return;

    const prefillEmail = () => {
      const emailInput = document.querySelector<HTMLInputElement>(
        'input[name="email"], input[type="email"]',
      );

      if (emailInput && !emailInput.value) {
        // Use React's way to set the value
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;

        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(emailInput, email);
          // Trigger React's onChange event
          const event = new Event("input", { bubbles: true });
          emailInput.dispatchEvent(event);
        } else {
          // Fallback
          emailInput.value = email;
          emailInput.dispatchEvent(new Event("input", { bubbles: true }));
          emailInput.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    };

    // Try multiple times as form might not be rendered immediately
    const timer1 = setTimeout(prefillEmail, 100);
    const timer2 = setTimeout(prefillEmail, 300);
    const timer3 = setTimeout(prefillEmail, 500);

    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
    };
  }, [email]);

  // Show loading while checking if user exists
  if (isCheckingInvitation && invitationId) {
    return (
      <main className="h-full flex items-center justify-center">
        <LoadingSpinner />
      </main>
    );
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <main className="h-full flex items-center justify-center p-4">
          <div className="w-full max-w-sm space-y-4">
            {invitationId && (
              <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-center space-y-2">
                <p className="text-sm text-blue-900 dark:text-blue-100 font-medium">
                  You've been invited to join Archestra workspace
                </p>
                {email && (
                  <p className="text-xs text-blue-700 dark:text-blue-300">
                    Email: {email}
                  </p>
                )}
              </div>
            )}
            <div className="w-full flex flex-col items-center justify-center">
              <AuthView
                path="sign-up"
                classNames={{ footer: "hidden" }}
                callbackURL={
                  invitationId
                    ? `/auth/sign-up-with-invitation?invitationId=${invitationId}${email ? `&email=${encodeURIComponent(email)}` : ""}`
                    : undefined
                }
              />
            </div>
          </div>
        </main>
      </Suspense>
    </ErrorBoundary>
  );
}

export default function SignUpWithInvitationPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <SignUpWithInvitationContent />
      </Suspense>
    </ErrorBoundary>
  );
}
