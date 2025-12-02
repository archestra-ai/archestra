"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { AuthViewWithErrorHandling } from "@/app/auth/_components/auth-view-with-error-handling";
import { DefaultCredentialsWarning } from "@/components/default-credentials-warning";
import { LoadingSpinner } from "@/components/loading";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import config from "@/lib/config";
import { useInvitationCheck } from "@/lib/invitation.query";

export function AuthPageWithInvitationCheck({ path }: { path: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invitationId = searchParams.get("invitationId");

  const { data: invitationData, isLoading } = useInvitationCheck(invitationId);

  const isBasicAuthDisabled = config.disableBasicAuth;

  // Check if this is a sign-up path (includes "sign-up-with-invitation")
  const isSignUpPath = path.startsWith("sign-up");

  // Redirect existing users from sign-up to sign-in
  useEffect(() => {
    if (
      isSignUpPath &&
      invitationId &&
      invitationData &&
      invitationData.userExists
    ) {
      // User already exists, redirect to sign-in with invitation ID preserved
      router.push(`/auth/sign-in?invitationId=${invitationId}`);
    }
  }, [isSignUpPath, invitationId, invitationData, router]);

  // Show loading while checking invitation
  if (isLoading && invitationId && isSignUpPath) {
    return (
      <main className="container flex grow flex-col items-center justify-center self-center h-full">
        <LoadingSpinner />
      </main>
    );
  }

  // Block direct sign-up without invitation
  if (isSignUpPath && !invitationId) {
    return (
      <main className="container flex grow flex-col items-center justify-center self-center p-4 md:p-6 h-full">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>Invitation Required</CardTitle>
            <CardDescription>
              Direct sign-up is disabled. You need an invitation to create an
              account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Please contact an administrator to get an invitation link. Once
              you have an invitation link, you'll be able to create your
              account.
            </p>
            <div className="flex gap-2">
              <a
                href="/auth/sign-in"
                className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background bg-primary text-primary-foreground hover:bg-primary/90 h-10 py-2 px-4 flex-1"
              >
                Sign In
              </a>
              <a
                href="/"
                className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background border border-input hover:bg-accent hover:text-accent-foreground h-10 py-2 px-4 flex-1"
              >
                Go Home
              </a>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  // Show appropriate message for sign-in with invitation
  const showExistingUserMessage =
    path === "sign-in" && invitationId && invitationData;

  // Only show default credentials warning when basic auth is enabled
  const showDefaultCredentialsWarning =
    path === "sign-in" && !invitationId && !isBasicAuthDisabled;

  return (
    <main className="container flex grow flex-col items-center justify-center self-center h-full">
      <div className="space-y-4 w-full max-w-md px-4 md:px-0">
        {showDefaultCredentialsWarning && (
          <div className="p-0 m-0 pb-4">
            <DefaultCredentialsWarning alwaysShow />
          </div>
        )}
        {showExistingUserMessage && (
          <Card className="mb-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Welcome Back!</CardTitle>
              <CardDescription>
                You already have an account. Please sign in to join the new
                organization.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
        <AuthViewWithErrorHandling
          path={path}
          callbackURL={
            invitationId
              ? `${path === "sign-in" ? "/auth/sign-in" : "/auth/sign-up"}?invitationId=${invitationId}`
              : undefined
          }
        />
      </div>
    </main>
  );
}
