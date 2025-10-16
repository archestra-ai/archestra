"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useAcceptInvitation } from "@/lib/organization.query";

export default function SignUpWithInvitationPage() {
  const searchParams = useSearchParams();
  const [hasProcessed, setHasProcessed] = useState(false);

  const invitationId = searchParams.get("invitationId");
  const email = searchParams.get("email");

  const { data: session } = authClient.useSession();
  const acceptMutation = useAcceptInvitation();

  // Handle auto-accept after sign-up
  useEffect(() => {
    // Only process if we've done initial check and now have a new session
    if (session && invitationId && !hasProcessed) {
      setHasProcessed(true);
      acceptMutation.mutateAsync(invitationId);
    }
  }, [session, invitationId, hasProcessed, acceptMutation.mutateAsync]);

  // Prefill and lock email field since user is invited to this specific email
  useEffect(() => {
    if (!email) return;

    const updateEmailField = () => {
      const emailInput = document.querySelector<HTMLInputElement>(
        'input[name="email"], input[type="email"]',
      );

      if (emailInput && emailInput.value !== email) {
        // Set the value
        emailInput.value = email;

        // Make it readonly since they're invited to this specific email
        emailInput.readOnly = true;
        emailInput.style.opacity = "0.7";
        emailInput.style.cursor = "not-allowed";

        // Trigger events to ensure form validation works
        emailInput.dispatchEvent(new Event("input", { bubbles: true }));
        emailInput.dispatchEvent(new Event("change", { bubbles: true }));

        // Also try to set the internal form state by triggering React's onChange
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(emailInput, email);
          emailInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    };

    // Initial update
    const initialTimer = setTimeout(updateEmailField, 100);

    // Set up a MutationObserver to watch for form changes
    const observer = new MutationObserver(updateEmailField);

    // Observe the entire document for changes
    const observerTimer = setTimeout(() => {
      const formContainer = document.querySelector("form");
      if (formContainer) {
        observer.observe(formContainer, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      }
    }, 100);

    // Also periodically check and update (as a fallback)
    const interval = setInterval(updateEmailField, 500);

    return () => {
      clearTimeout(initialTimer);
      clearTimeout(observerTimer);
      clearInterval(interval);
      observer.disconnect();
    };
  }, [email]);

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <main className="flex grow flex-col items-center justify-center md:p-6 h-full">
          <div className="w-[384px] space-y-4">
            {invitationId && (
              <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-center space-y-2">
                <p className="text-sm text-blue-900 dark:text-blue-100 font-medium">
                  You've been invited to join an organization
                </p>
                {email && (
                  <p className="text-xs text-blue-700 dark:text-blue-300">
                    Email: {email}
                  </p>
                )}
              </div>
            )}
            <div className="w-full flex flex-col items-center justify-center">
              <AuthView path="sign-up" />
            </div>
          </div>
        </main>
      </Suspense>
    </ErrorBoundary>
  );
}
