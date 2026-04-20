"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { AuthViewWithErrorHandling } from "@/app/auth/_components/auth-view-with-error-handling";
import { BackendConnectivityStatus } from "@/app/auth/_components/backend-connectivity-status";
import { AppLogo } from "@/components/app-logo";
import { CommunityLinks } from "@/components/community-links";
import { DefaultCredentialsWarning } from "@/components/default-credentials-warning";
import { LoadingSpinner } from "@/components/loading";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useInvitationCheck } from "@/lib/auth/invitation.query";
import { usePublicConfig } from "@/lib/config/config.query";
import { getValidatedRedirectPath } from "@/lib/utils/redirect-validation";

export function AuthPageWithInvitationCheck({ path }: { path: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invitationId = searchParams.get("invitationId");
  const redirectTo = searchParams.get("redirectTo");

  const { data: invitationData, isLoading } = useInvitationCheck(invitationId);
  const { data: publicConfig, isLoading: isLoadingPublicConfig } =
    usePublicConfig();
  const isBasicAuthDisabled = publicConfig?.disableBasicAuth ?? false;

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
      <main className="h-full flex items-center justify-center">
        <LoadingSpinner />
      </main>
    );
  }

  // Block direct sign-up without invitation
  if (isSignUpPath && !invitationId) {
    return (
      <main className="h-full flex items-center justify-center p-4">
        <div className="space-y-4 w-full max-w-md">
          <AppLogo />
          <Card className="w-full">
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
          <CommunityLinks />
        </div>
      </main>
    );
  }

  // Show appropriate message for sign-in with invitation
  const showExistingUserMessage =
    path === "sign-in" && invitationId && invitationData;

  // Only show default credentials warning when basic auth is enabled
  const showDefaultCredentialsWarning =
    path === "sign-in" &&
    !invitationId &&
    !isLoadingPublicConfig &&
    !isBasicAuthDisabled;

  const isSignInOrSignUp = path === "sign-in" || isSignUpPath;

  return (
    <BackendConnectivityStatus>
      <main className="h-full flex items-center justify-center p-4">
        <div className="space-y-4 w-full max-w-md">
          {isSignInOrSignUp && <AppLogo />}
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
          {/*
            callbackURL behavior differs by flow:
            - Invitation flow: Points back to auth page with invitationId preserved.
              After OAuth/SSO completes, user returns here to trigger invitation acceptance.
            - Normal flow: Points to final destination (from redirectTo param or /).
              After auth completes, user goes directly to their intended page.
          */}
          <AuthViewWithErrorHandling
            path={path}
            callbackURL={getAuthCallbackURL({
              invitationId,
              path,
              redirectTo,
              searchParams,
            })}
          />
          {isSignInOrSignUp && <CommunityLinks />}
        </div>
      </main>
    </BackendConnectivityStatus>
  );
}

const OAUTH_AUTHORIZE_REQUIRED_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
] as const;

function getAuthCallbackURL(params: {
  invitationId: string | null;
  path: string;
  redirectTo: string | null;
  searchParams: ReturnType<typeof useSearchParams>;
}) {
  const { invitationId, path, redirectTo, searchParams } = params;

  if (invitationId) {
    return `${
      path === "sign-in" ? "/auth/sign-in" : "/auth/sign-up"
    }?invitationId=${invitationId}`;
  }

  const oauthAuthorizeCallbackURL = getOAuthAuthorizeCallbackURL(searchParams);
  if (oauthAuthorizeCallbackURL) {
    return oauthAuthorizeCallbackURL;
  }

  return getValidatedRedirectPath(redirectTo);
}

function getOAuthAuthorizeCallbackURL(
  searchParams: ReturnType<typeof useSearchParams>,
) {
  const hasOAuthAuthorizeParams = OAUTH_AUTHORIZE_REQUIRED_PARAMS.every(
    (param) => searchParams.get(param) !== null,
  );

  if (!hasOAuthAuthorizeParams) {
    return null;
  }

  const queryString = searchParams.toString();
  return queryString ? `/api/auth/oauth2/authorize?${queryString}` : null;
}
