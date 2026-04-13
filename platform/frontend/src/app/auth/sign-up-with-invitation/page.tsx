"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { AUTO_PROVISIONED_INVITATION_STATUS } from "@shared";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AppLogo } from "@/components/app-logo";
import { CommunityLinks } from "@/components/community-links";
import { LoadingSpinner } from "@/components/loading";
import { useInvitationCheck } from "@/lib/auth/invitation.query";
import { useAppName } from "@/lib/hooks/use-app-name";

function setInputValue(input: HTMLInputElement, value: string) {
  // Better Auth UI owns these inputs internally, so direct assignment is not
  // enough to notify its React handlers. Use the native setter to keep the
  // third-party controlled field state in sync with the DOM value.
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function prefillInvitationFormField(params: {
  selector: string;
  value: string | null;
}) {
  if (!params.value) {
    return true;
  }

  const input = document.querySelector<HTMLInputElement>(params.selector);
  if (!input) {
    return false;
  }

  if (!input.value) {
    setInputValue(input, params.value);
  }

  return input.value === params.value;
}

function SignUpWithInvitationContent() {
  const appName = useAppName();
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
    if (!email && !name) {
      return;
    }

    const prefillFields = () =>
      prefillInvitationFormField({
        selector: 'input[name="email"], input[type="email"]',
        value: email,
      }) &&
      prefillInvitationFormField({
        selector: 'input[name="name"]',
        value: name,
      });

    if (prefillFields()) {
      return;
    }

    const cleanupCallbacks: Array<() => void> = [];

    const stopWatching = () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
    };

    const ensureFieldsPrefilled = () => {
      if (prefillFields()) {
        stopWatching();
      }
    };

    const observer = new MutationObserver(() => {
      ensureFieldsPrefilled();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["value"],
    });
    cleanupCallbacks.push(() => observer.disconnect());

    const interval = window.setInterval(ensureFieldsPrefilled, 100);
    cleanupCallbacks.push(() => window.clearInterval(interval));

    const timeout = window.setTimeout(stopWatching, 5_000);
    cleanupCallbacks.push(() => window.clearTimeout(timeout));

    return () => {
      stopWatching();
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
            <AppLogo />
            {invitationId && (
              <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-center space-y-2">
                <p className="text-sm text-blue-900 dark:text-blue-100 font-medium">
                  You've been invited to join the {appName} workspace
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
            <CommunityLinks />
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
