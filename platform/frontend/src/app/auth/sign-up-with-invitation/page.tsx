"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";

export default function SignUpWithInvitationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [hasProcessed, setHasProcessed] = useState(false);
  const [initialSessionChecked, setInitialSessionChecked] = useState(false);
  const [isRedirecting, setIsRedirecting] = useState(false);

  const invitationId = searchParams.get("invitationId");
  const _email = searchParams.get("email");

  const { data: session } = authClient.useSession();

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

  // Handle auto-accept after sign-up
  useEffect(() => {
    const processInvitation = async () => {
      // Don't auto-accept if we're redirecting an already-authenticated user
      if (isRedirecting) return;

      // Only process if we've done initial check and now have a new session
      if (initialSessionChecked && session && invitationId && !hasProcessed) {
        setHasProcessed(true);

        try {
          const { error } = await authClient.organization.acceptInvitation({
            invitationId,
          });

          if (error) {
            toast.error("Error", {
              description: error.message || "Failed to accept invitation",
            });
            router.push(`/accept-invitation/${invitationId}`);
          } else {
            toast.success("Welcome!", {
              description:
                "Your account has been created and you've joined the organization",
            });
            router.push("/");
          }
        } catch (_err) {
          toast.error("Error", {
            description: "An unexpected error occurred",
          });
          router.push(`/accept-invitation/${invitationId}`);
        }
      }
    };

    processInvitation();
  }, [
    session,
    invitationId,
    hasProcessed,
    router,
    initialSessionChecked,
    isRedirecting,
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
              Create your account or{" "}
              <a
                href={`/auth/sign-in-with-invitation?invitationId=${invitationId}`}
                className="underline font-medium hover:text-blue-900 dark:hover:text-blue-50"
              >
                sign in if you already have an account
              </a>
            </p>
          </div>
        )}
        <AuthView path="sign-up" />
      </div>
    </main>
  );
}
