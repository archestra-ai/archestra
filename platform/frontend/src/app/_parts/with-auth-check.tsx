"use client";

import { usePathname, useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { LoadingState } from "@/components/loading";
import { useSession } from "@/lib/auth/auth.query";
import { usePublicConfig } from "@/lib/config/config.query";
import { errorReporting } from "@/lib/error-reporting";
import { getValidatedRedirectPath } from "@/lib/utils/redirect-validation";
import { AuthSurfaceFrame } from "./auth-surface-frame";

const pathCorrespondsToAnAuthPage = (pathname: string) => {
  return (
    pathname?.startsWith("/auth/sign-in") ||
    pathname?.startsWith("/auth/sign-up") ||
    pathname?.startsWith("/auth/sso") ||
    pathname?.startsWith("/auth/sign-out")
  );
};

/**
 * The developer auto-login loads the document again once it has a session
 * cookie. The time of the attempt is kept for the tab, so a cookie the browser
 * did not keep (the reloaded page is signed out again) leads to the sign-in
 * page instead of another attempt.
 */
const DEV_AUTO_LOGIN_ATTEMPTED_AT_KEY = "archestra.dev-auto-login.attempted-at";
const DEV_AUTO_LOGIN_RETRY_AFTER_MS = 15_000;

function devAutoLoginAttemptedRecently(): boolean {
  try {
    const attemptedAt = Number(
      window.sessionStorage.getItem(DEV_AUTO_LOGIN_ATTEMPTED_AT_KEY),
    );
    return (
      attemptedAt > 0 &&
      Date.now() - attemptedAt < DEV_AUTO_LOGIN_RETRY_AFTER_MS
    );
  } catch {
    return false;
  }
}

function noteDevAutoLoginAttempt() {
  try {
    window.sessionStorage.setItem(
      DEV_AUTO_LOGIN_ATTEMPTED_AT_KEY,
      String(Date.now()),
    );
  } catch {
    // No storage: the ref in the component still limits this page to one try.
  }
}

/**
 * Auth pages that can be accessed regardless of login state.
 * - /auth/two-factor is used for both:
 *   1. 2FA verification during login (user not fully logged in yet)
 *   2. 2FA setup after enabling 2FA (user is logged in)
 * - /auth/recover-account completes a 2FA sign-in with a backup code, so the
 *   user is not fully logged in yet either
 * - /auth/sign-out must be accessible when logged in to perform sign-out
 */
const isSpecialAuthPage = (pathname: string) => {
  return (
    pathname?.startsWith("/auth/two-factor") ||
    pathname?.startsWith("/auth/recover-account") ||
    pathname?.startsWith("/auth/sso") ||
    pathname?.startsWith("/auth/sign-out")
  );
};

export const WithAuthCheck: React.FC<
  React.PropsWithChildren<{
    /**
     * The document request carried a session cookie (read by the root layout
     * on the server). Unverified — get-session still decides — but enough to
     * draw the signed-in app while that request is in flight.
     */
    hasSessionCookie?: boolean;
  }>
> = ({ children, hasSessionCookie = false }) => {
  const router = useRouter();
  const pathname = usePathname();
  // useSearchParams is intentionally not used here to avoid the need
  // to wrap whole app in Suspense which causes flickering
  const searchParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const [isMounted, setIsMounted] = useState(false);

  const {
    data: session,
    isPending: isAuthPending,
    isRefetching: isAuthRefetching,
  } = useSession();

  // Developer-only auto-login (never enabled in production). When on, an
  // unauthenticated visitor gets a real session minted server-side instead of
  // the sign-in form. Gate the redirect on this being resolved so we don't flash
  // the login page before we know it's enabled.
  const { data: publicConfig, isLoading: isPublicConfigLoading } =
    usePublicConfig();
  const devAutoLoginEnabled = publicConfig?.devAutoLoginEnabled ?? false;
  const devAutoLoginRef = useRef<"idle" | "pending" | "failed">("idle");

  const isLoggedIn = session?.user;
  const isAuthPage = pathCorrespondsToAnAuthPage(pathname);
  const isSpecialAuth = isSpecialAuthPage(pathname);

  // Track mount state to avoid hydration errors with isRefetching
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Only use isRefetching after mount to avoid SSR/client hydration mismatch
  // Before mount, treat as initializing to match SSR behavior
  const isAuthInitializing = isMounted
    ? isAuthPending && !isAuthRefetching // After mount: distinguish refetch from initial
    : isAuthPending; // During SSR/hydration: just check isPending

  const inProgress = isAuthInitializing;

  // Set Sentry user context when user is authenticated
  useEffect(() => {
    if (session?.user) {
      errorReporting.setUser({
        id: session.user.id,
        email: session.user.email,
        username: session.user.name || session.user.email,
      });
    } else {
      // Clear user context when not authenticated
      errorReporting.setUser(null);
    }
  }, [session?.user]);

  // Redirect to home if user is logged in and on auth page, or if user is not logged in and not on auth page
  useEffect(() => {
    if (isAuthInitializing || isAuthRefetching || isPublicConfigLoading) {
      // If auth or public-config check is pending, don't do anything
      return;
    } else if (isSpecialAuth) {
      // Special auth pages (like /auth/two-factor) can be accessed regardless of login state
      // - During login: user needs to complete 2FA verification (not logged in yet)
      // - During setup: user is setting up 2FA (logged in)
      return;
    } else if (isAuthPage && isLoggedIn) {
      // User is logged in but on auth page (sign-in/sign-up), redirect to redirectTo or home
      const redirectTo = searchParams.get("redirectTo");
      router.push(getValidatedRedirectPath(redirectTo));
    } else if (!isAuthPage && !isLoggedIn) {
      const queryString = searchParams.toString();
      const fullPath = `${pathname}${queryString ? `?${queryString}` : ""}${window.location.hash}`;
      if (devAutoLoginEnabled && devAutoLoginRef.current === "pending") {
        // An attempt is in flight: it ends in a reload or the redirect below.
        return;
      }
      // Developer-only: mint a session server-side instead of showing the login
      // form, then load the document again with the new cookie. The server
      // seeds a signed-in document (session, bootstrap, the page's first rows),
      // so the reloaded page paints complete, as it does for a visitor who
      // signed in through the form; resolving the session here instead would
      // load all of that in the browser, with the layout settling as it lands.
      // On any failure, fall back to the normal sign-in redirect.
      if (
        devAutoLoginEnabled &&
        devAutoLoginRef.current === "idle" &&
        !devAutoLoginAttemptedRecently()
      ) {
        devAutoLoginRef.current = "pending";
        void fetch("/api/auth/dev-auto-login", { method: "POST" })
          .then((res) => {
            if (!res.ok) {
              throw new Error(`dev-auto-login failed: ${res.status}`);
            }
            noteDevAutoLoginAttempt();
            window.location.reload();
          })
          .catch(() => {
            devAutoLoginRef.current = "failed";
            router.push(
              `/auth/sign-in?redirectTo=${encodeURIComponent(fullPath)}`,
            );
          });
        return;
      }
      // User is not logged in and not on any auth page, redirect to sign-in.
      // Preserve the original URL (including query params) so we can redirect back after login
      router.push(`/auth/sign-in?redirectTo=${encodeURIComponent(fullPath)}`);
    }
  }, [
    isAuthInitializing,
    isAuthRefetching,
    isPublicConfigLoading,
    isAuthPage,
    isLoggedIn,
    router,
    isSpecialAuth,
    pathname,
    searchParams,
    devAutoLoginEnabled,
  ]);

  // An unresolved session means we do not yet know whether this person gets
  // the app or the sign-in page. Rendering either one's chrome now would flash
  // the wrong layout, and a full-screen spinner is the jumpy boot loader this
  // screen is meant to be rid of — so hold the background steady and say
  // nothing visually. A refresh normally skips this branch entirely: the
  // session comes back with the restored cache, already resolved.
  //
  // Auth surfaces are deliberately exempt. They do not have a second layout to
  // guess at: the sign-in form is static markup that is correct for every
  // visitor who is not signed in, which on a sign-in page is very nearly all
  // of them — and always the one arriving from sign-out, whose session was
  // just destroyed. Holding it back bought only the certainty that a visitor
  // who *is* signed in never glimpses a form before being redirected, and
  // charged every real sign-in ~550ms for it. That visitor is being sent
  // somewhere else either way; the branch below still catches them the moment
  // the session resolves, and now they are interrupted from a form rather than
  // from a spinner.
  //
  // A session cookie changes the odds: the visitor is almost certainly signed
  // in, so the app renders straight away — on the server too, which puts the
  // shell and the chat composer in the HTML — while get-session runs in
  // parallel with the page's own queries. If it says there is no user after
  // all (an expired or revoked cookie), the branch below swaps the app for the
  // sign-in redirect; 401s fired in the meantime are not toasted (see
  // sessionConfirmation in handleApiError).
  if (inProgress && !isAuthPage && !isSpecialAuth) {
    if (hasSessionCookie) return <>{children}</>;
    return <LoadingState label="Loading…" variant="quiet" />;
  }

  if (isSpecialAuth) {
    // Special auth pages are always rendered (handles both 2FA verification and setup)
    return <>{children}</>;
  } else if (isAuthPage && isLoggedIn) {
    return (
      <AuthSurfaceFrame>
        <LoadingState label="Redirecting…" variant="fill" />
      </AuthSurfaceFrame>
    );
  } else if (!isAuthPage && !isLoggedIn) {
    return <LoadingState label="Redirecting to sign-in…" variant="viewport" />;
  }

  return <>{children}</>;
};
