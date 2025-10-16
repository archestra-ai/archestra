"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { authClient } from "@/lib/clients/auth/auth-client";

export default function SignInWithInvitationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [hasProcessed, setHasProcessed] = useState(false);

  const invitationId = searchParams.get("invitationId");

  const { data: session } = authClient.useSession();

  // Handle auto-accept after sign-up
  useEffect(() => {
    // Only process if we've done initial check and now have a new session
    if (session && invitationId && !hasProcessed) {
      setHasProcessed(true);
      router.push(`/accept-invitation/${invitationId}`);
    }
  }, [session, invitationId, hasProcessed, router]);

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <main className="container flex grow flex-col items-center justify-center self-center p-4 md:p-6">
          <div className="w-full max-w-md space-y-4">
            {invitationId && (
              <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-center">
                <p className="text-sm text-blue-900 dark:text-blue-100">
                  You've been invited to join an organization
                </p>
                <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
                  Sign in to accept the invitation or{" "}
                  <a
                    href={`/auth/sign-up-with-invitation?invitationId=${invitationId}`}
                    className="underline font-medium hover:text-blue-900 dark:hover:text-blue-50"
                  >
                    create a new account
                  </a>
                </p>
              </div>
            )}
            <AuthView path="sign-in" />
          </div>
        </main>
      </Suspense>
    </ErrorBoundary>
  );
}
