"use client";

import { requiredPagePermissionsMap } from "@shared";
import { usePathname, useRouter } from "next/navigation";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";

const pathCorrespondsToAnAuthPage = (pathname: string) => {
  return (
    pathname?.startsWith("/auth/sign-in") ||
    pathname?.startsWith("/auth/sign-up") ||
    pathname?.startsWith("/auth/two-factor")
  );
};

export function WithAuthCheck({
  children,
}: {
  children: ReactElement;
}): ReactElement | null {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending: isAuthCheckPending } =
    authClient.useSession();

  const isLoggedIn = session?.user;
  const isAuthPage = pathCorrespondsToAnAuthPage(pathname);
  const isAuthPageAndUserLoggedIn = isAuthPage && isLoggedIn;
  const isNotAuthPageAndUserNotLoggedIn = !isAuthPage && !isLoggedIn;

  // Get required permissions for current page
  const requiredPermissions = requiredPagePermissionsMap[pathname];
  const { data: hasRequiredPermissions, isPending: isPermissionCheckPending } =
    useHasPermissions(requiredPermissions || {});

  const loading = isAuthCheckPending || isPermissionCheckPending;

  // Redirect to home if user is logged in and on auth page, or if user is not logged in and not on auth page
  useEffect(() => {
    if (isAuthCheckPending) {
      // If auth check is pending, don't do anything
      return;
    } else if (isAuthPageAndUserLoggedIn) {
      // User is logged in but on auth page, redirect to home
      router.push("/");
    } else if (isNotAuthPageAndUserNotLoggedIn) {
      // User is not logged in and not on auth page, redirect to sign-in
      router.push("/auth/sign-in");
    }
  }, [
    isAuthCheckPending,
    isAuthPageAndUserLoggedIn,
    isNotAuthPageAndUserNotLoggedIn,
    router,
  ]);

  // Redirect to home if page is protected and user is not authorized
  useEffect(() => {
    if (loading) {
      return;
    }

    if (requiredPermissions && !hasRequiredPermissions) {
      router.push("/");
    }
  }, [loading, requiredPermissions, hasRequiredPermissions, router]);

  if (loading) {
    return null;
  }

  // During redirect, show nothing
  if (isAuthPageAndUserLoggedIn || isNotAuthPageAndUserNotLoggedIn) {
    return null;
  }

  return <>{children}</>;
}
