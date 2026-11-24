"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { AuthViewWithErrorHandling } from "@/app/auth/_parts/auth-view-with-error-handling";
import { BackendConnectivityStatus } from "@/app/auth/_parts/backend-connectivity-status";
import { SignInNotice } from "@/app/auth/_parts/sign-in-notice";
import { AppLogo } from "@/components/app-logo";
import { CommunityLinks } from "@/components/community-links";
import { LoadingState } from "@/components/loading";
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
import { cn } from "@/lib/utils/tailwind";

export function AuthPageWithInvitationCheck({ path }: { path: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invitationId = searchParams.get("invitationId");
  const redirectTo = searchParams.get("redirectTo");

  const { data: invitationData } = useInvitationCheck(invitationId);
  const { data: publicConfig, isLoading: isLoadingPublicConfig } =
    usePublicConfig();
  const isBasicAuthDisabled = publicConfig?.disableBasicAuth ?? false;

  const isSignUpPath = path.startsWith("sign-up");

  // Sign-up always goes through the invitation flow, which has its own page
  // (with invitation validation and existing-user handling).
  useEffect(() => {
    if (isSignUpPath && invitationId) {
      router.replace(
        `/auth/sign-up-with-invitation?${searchParams.toString()}`,
      );
    }
  }, [isSignUpPath, invitationId, router, searchParams]);

  // Show loading while checking the invitation or redirecting to the
  // sign-up-with-invitation page
  if (invitationId && isSignUpPath) {
    // No wrapper: `fill` centres in the frame slot the shell already gives
    // this route. A `h-full` <main> around it resolves to zero height inside
    // that flex column and drops the indicator at the top of the screen.
    return <LoadingState variant="fill" />;
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

  // The notice (default credentials, SSO setup) only concerns password
  // sign-in. With it disabled, the card already says how to sign in.
  const isPlainSignIn = path === "sign-in" && !invitationId;
  const showSignInNotice =
    isPlainSignIn && !isLoadingPublicConfig && !isBasicAuthDisabled;

  const isSignInOrSignUp = path === "sign-in" || isSignUpPath;
  // Every standalone auth surface mirrors the sign-in layout (logo on top);
  // only flows that continue an already-branded page skip it.
  const showLogo =
    isSignInOrSignUp ||
    path === "two-factor" ||
    path === "two-factor-setup" ||
    path === "recover-account";

  return (
    <BackendConnectivityStatus>
      <main
        className={cn(
          "h-full p-4",
          isPlainSignIn
            ? "overflow-y-auto"
            : "flex items-center justify-center",
        )}
      >
        <div
          className={cn(
            "w-full max-w-md",
            isPlainSignIn
              ? "mx-auto grid h-full grid-rows-[minmax(15rem,1fr)_auto_minmax(1rem,1fr)] sm:grid-rows-[minmax(13rem,1fr)_auto_minmax(1rem,1fr)]"
              : "space-y-4",
          )}
        >
          {isPlainSignIn ? (
            // This row's size is independent of the late notice. Keep both
            // above the form without delaying or moving the form. Allow
            // scrolling when the notice wraps at a narrow width or high zoom.
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pb-4 [contain:size]">
              <div className="mt-auto shrink-0">
                <AppLogo />
              </div>
              {showSignInNotice && <SignInNotice />}
            </div>
          ) : (
            showLogo && <AppLogo />
          )}
          <div className="space-y-4">
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
                redirectTo,
                searchParams,
              })}
            />
            {isSignInOrSignUp && <CommunityLinks />}
          </div>
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
  redirectTo: string | null;
  searchParams: ReturnType<typeof useSearchParams>;
}) {
  const { invitationId, redirectTo, searchParams } = params;

  if (invitationId) {
    // Only sign-in reaches this point; sign-up with an invitation is
    // redirected to /auth/sign-up-with-invitation before rendering.
    return `/auth/sign-in?invitationId=${invitationId}`;
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
