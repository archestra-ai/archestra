"use client";

import * as Sentry from "@sentry/nextjs";
import { requiredPagePermissionsMap } from "@shared";
import { usePathname, useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useState } from "react";
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";

const pathCorrespondsToAnAuthPage = (pathname: string) => {
  return (
    pathname?.startsWith("/auth/sign-in") ||
    pathname?.startsWith("/auth/sign-up") ||
    pathname?.startsWith("/auth/two-factor")
  );
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

  // Track mount state to avoid hydration errors with isRefetching
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Only use isRefetching after mount to avoid SSR/client hydration mismatch
  // Before mount, treat as initializing to match SSR behavior
  const isAuthInitializing = isMounted
    ? isAuthPending && !isAuthRefetching // After mount: distinguish refetch from initial
    : isAuthPending; // During SSR/hydration: just check isPending

  // Get required permissions for current page
  const requiredPermissions = requiredPagePermissionsMap[pathname];
  const { data: hasRequiredPermissions, isPending: isPermissionCheckPending } =
    useHasPermissions(requiredPermissions || {});

  // On auth pages, only wait for auth check (no permission check needed)
  // On other pages, wait for both auth and permission checks
  const inProgress = isAuthPage
    ? isAuthInitializing
    : isAuthInitializing || isPermissionCheckPending;

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
    } else if (isAuthPage && isLoggedIn) {
      // User is logged in but on auth page, redirect to home
      router.push("/");
    } else if (!isAuthPage && !isLoggedIn) {
      // User is not logged in and not on auth page, redirect to sign-in
      router.push("/auth/sign-in");
    }
  }, [isAuthInitializing, isAuthRefetching, isAuthPage, isLoggedIn, router]);

  // Redirect to home if page is protected and user is not authorized
  useEffect(() => {
    if (inProgress) {
      return;
    }

    if (requiredPermissions && !hasRequiredPermissions) {
      router.push("/");
    }
  }, [inProgress, requiredPermissions, hasRequiredPermissions, router]);

  // Show loading while checking auth/permissions
  if (inProgress) {
    return null;
  } else if (isAuthPage && isLoggedIn) {
    // During redirects, show nothing to avoid flash
    return null;
  } else if (!isAuthPage && !isLoggedIn) {
    return null;
  }

  return <>{children}</>;
};
