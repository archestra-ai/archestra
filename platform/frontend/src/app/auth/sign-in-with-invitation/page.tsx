"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useProcessInvitation } from "@/lib/organization.query";

export default function SignInWithInvitationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [hasProcessed, setHasProcessed] = useState(false);
  const [initialSessionChecked, setInitialSessionChecked] = useState(false);
  const [isRedirecting, setIsRedirecting] = useState(false);

  const invitationId = searchParams.get("invitationId");

  const { data: session } = authClient.useSession();
  const { processInvitation } = useProcessInvitation();

  // Check if user is already authenticated on mount
  useEffect(() => {
    if (!initialSessionChecked) {
      if (session && invitationId) {
        // User is already logged in, redirect to accept page
        setIsRedirecting(true);
        router.push(`/accept-invitation/${invitationId}`);
        return;
      }
      setInitialSessionChecked(true);
    }
  }, [session, invitationId, router, initialSessionChecked]);

  // Handle auto-accept after sign-in
  useEffect(() => {
    const handleProcessInvitation = async () => {
      // Don't auto-accept if we're redirecting an already-authenticated user
      if (isRedirecting) return;

      // Only process if we've done initial check and now have a new session
      if (initialSessionChecked && session && invitationId && !hasProcessed) {
        setHasProcessed(true);

        try {
          await processInvitation(invitationId);
          toast.success("Welcome back!", {
            description: "You've successfully joined the organization",
          });
          router.push("/");
        } catch (error: any) {
          toast.error("Error", {
            description: error.message || "Failed to accept invitation",
          });
          router.push(`/accept-invitation/${invitationId}`);
        }
      }
    };

    handleProcessInvitation();
  }, [
    session,
    invitationId,
    hasProcessed,
    router,
    initialSessionChecked,
    isRedirecting,
    processInvitation,
  ]);

  return (
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
  );
}
