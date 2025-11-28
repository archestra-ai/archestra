"use client";

import * as Sentry from "@sentry/nextjs";
import { usePathname, useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/clients/auth/auth-client";

const pathCorrespondsToAnAuthPage = (pathname: string) => {
  return (
    pathname?.startsWith("/auth/sign-in") ||
    pathname?.startsWith("/auth/sign-up")
  );
};

/**
 * Auth pages that can be accessed regardless of login state.
 * - /auth/two-factor is used for both:
 *   1. 2FA verification during login (user not fully logged in yet)
 *   2. 2FA setup after enabling 2FA (user is logged in)
 */
const isSpecialAuthPage = (pathname: string) => {
  return pathname?.startsWith("/auth/two-factor");
};

export const WithAuthCheck: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const router = useRouter();
  const pathname = usePathname();
  const [isMounted, setIsMounted] = useState(false);

  const {
    data: session,
    isPending: isAuthPending,
    isRefetching: isAuthRefetching,
  } = authClient.useSession();

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
      try {
        Sentry.setUser({
          id: session.user.id,
          email: session.user.email,
          username: session.user.name || session.user.email,
        });
      } catch (_error) {
        // Silently fail if Sentry is not configured
      }
    } else {
      // Clear user context when not authenticated
      try {
        Sentry.setUser(null);
      } catch (_error) {
        // Silently fail if Sentry is not configured
      }
    }
  }, [session?.user]);

  // Redirect to home if user is logged in and on auth page, or if user is not logged in and not on auth page
  useEffect(() => {
    if (isAuthInitializing || isAuthRefetching) {
      // If auth check is pending, don't do anything
      return;
    } else if (isSpecialAuth) {
      // Special auth pages (like /auth/two-factor) can be accessed regardless of login state
      // - During login: user needs to complete 2FA verification (not logged in yet)
      // - During setup: user is setting up 2FA (logged in)
      return;
    } else if (isAuthPage && isLoggedIn) {
      // User is logged in but on auth page (sign-in/sign-up), redirect to home
      router.push("/");
    } else if (!isAuthPage && !isLoggedIn) {
      // User is not logged in and not on any auth page, redirect to sign-in
      router.push("/auth/sign-in");
    }
  }, [
    isAuthInitializing,
    isAuthRefetching,
    isAuthPage,
    isLoggedIn,
    router,
    isSpecialAuth,
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
