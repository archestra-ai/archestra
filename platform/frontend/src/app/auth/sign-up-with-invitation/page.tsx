"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { AUTO_PROVISIONED_INVITATION_STATUS } from "@shared";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { useInvitationCheck } from "@/lib/invitation.query";

function SignUpWithInvitationContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invitationId = searchParams.get("invitationId");
  const email = searchParams.get("email");
  const name = searchParams.get("name");
  const { data: invitationData, isLoading: isCheckingInvitation } =
    useInvitationCheck(invitationId);

  // Redirect existing users to sign-in (unless auto-provisioned — they need to sign up)
  useEffect(() => {
    if (
      invitationId &&
      invitationData?.userExists &&
      !invitationData.invitation?.status?.startsWith(
        AUTO_PROVISIONED_INVITATION_STATUS,
      )
    ) {
      router.push(`/auth/sign-in?invitationId=${invitationId}`);
    }
  }, [invitationId, invitationData, router]);

  // Prefill form fields (but keep them editable for form validation)
  useEffect(() => {
    if (!email && !name) return;

    const setInputValue = (input: HTMLInputElement, value: string) => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };

    const prefillFields = () => {
      if (email) {
        const emailInput = document.querySelector<HTMLInputElement>(
          'input[name="email"], input[type="email"]',
        );
        if (emailInput && !emailInput.value) setInputValue(emailInput, email);
      }
      if (name) {
        const nameInput =
          document.querySelector<HTMLInputElement>('input[name="name"]');
        if (nameInput && !nameInput.value) setInputValue(nameInput, name);
      }
    };

    // Try multiple times as form might not be rendered immediately
    const timer1 = setTimeout(prefillFields, 100);
    const timer2 = setTimeout(prefillFields, 300);
    const timer3 = setTimeout(prefillFields, 500);

    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
    };
  }, [email, name]);

  // Show loading while checking session, signing out, or checking invitation
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
