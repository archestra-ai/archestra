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

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <main className="flex grow flex-col items-center justify-center md:p-6 h-full">
          <div className="w-[384px] space-y-4">
            {invitationId && (
              <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-center">
                <p className="text-sm text-blue-900 dark:text-blue-100">
                  You've been invited to join an organization
                </p>
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
