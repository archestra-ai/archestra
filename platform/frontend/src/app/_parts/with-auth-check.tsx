"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { authQueryKeys, useSession } from "@/lib/auth/auth.query";
import { usePublicConfig } from "@/lib/config/config.query";
import { getValidatedRedirectPath } from "@/lib/utils/redirect-validation";

type ErrorReportingUser = Parameters<
  typeof import("@sentry/nextjs").setUser
>[0];

const safeSetErrorReportingUser = (user: ErrorReportingUser) => {
  void import("@sentry/nextjs")
    .then(({ setUser }) => {
      setUser(user);
    })
    .catch(() => undefined);
};

const pathCorrespondsToAnAuthPage = (pathname: string) => {
  return (
    pathname?.startsWith("/auth/sign-in") ||
    pathname?.startsWith("/auth/sign-up") ||
    pathname?.startsWith("/auth/sso") ||
    pathname?.startsWith("/auth/sign-out")
  );
};

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

export const WithAuthCheck: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
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
  const devAutoLoginAttemptedRef = useRef(false);

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
      safeSetErrorReportingUser({
        id: session.user.id,
        email: session.user.email,
        username: session.user.name || session.user.email,
      });
    } else {
      // Clear user context when not authenticated
      safeSetErrorReportingUser(null);
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
      const fullPath = queryString ? `${pathname}?${queryString}` : pathname;
      // Developer-only: mint a session server-side instead of showing the login
      // form. On any failure, fall back to the normal sign-in redirect.
      if (devAutoLoginEnabled && !devAutoLoginAttemptedRef.current) {
        devAutoLoginAttemptedRef.current = true;
        void fetch("/api/auth/dev-auto-login", { method: "POST" })
          .then((res) => {
            if (!res.ok) {
              throw new Error(`dev-auto-login failed: ${res.status}`);
            }
            return queryClient.invalidateQueries({
              queryKey: authQueryKeys.session(),
            });
          })
          .catch(() => {
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
    queryClient,
  ]);

  // Show loading while checking auth/permissions
  if (inProgress) {
    return null;
  } else if (isSpecialAuth) {
    // Special auth pages are always rendered (handles both 2FA verification and setup)
    return <>{children}</>;
  } else if (isAuthPage && isLoggedIn) {
    // During redirects, show nothing to avoid flash
    return null;
  } else if (!isAuthPage && !isLoggedIn) {
    return null;
  }

  return <>{children}</>;
};
