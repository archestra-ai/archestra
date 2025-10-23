"use client";

import { usePathname, useRouter } from "next/navigation";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { authClient } from "@/lib/clients/auth/auth-client";
import type { Role } from "../../../../shared";

export function WithAuthCheck({
  children,
}: {
  children: ReactElement;
}): ReactElement | null {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending: isAuthCheckPending } =
    authClient.useSession();

  const role = session?.user?.role;

  const isAuthPage =
    pathname?.startsWith("/auth/sign-in") ||
    pathname?.startsWith("/auth/sign-up");
  const isPublicPage = pathname === "/test-agent"; // "How it works" page is public
  const isAuthPageAndUserLoggedIn = isAuthPage && session?.user;
  const isNotAuthPageAndUserNotLoggedIn =
    !isAuthPage && !isPublicPage && !session?.user;

  // Redirect to home if user is logged in and on auth page, or if user is not logged in and not on auth page
  useEffect(() => {
    // If auth check is pending, don't do anything
    if (isAuthCheckPending) return;

    // User is logged in but on auth page, redirect to home
    if (isAuthPageAndUserLoggedIn) {
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
    if (isAuthCheckPending) return;

    const requiredRole = PAGE_WITH_REQUIRED_ROLE[pathname];
    if (requiredRole && role !== requiredRole) {
      router.push("/");
    }
  }, [isAuthCheckPending, pathname, router, role]);

  if (isAuthCheckPending) {
    return null;
  }

  // During redirect, show nothing
  if (isAuthPageAndUserLoggedIn || isNotAuthPageAndUserNotLoggedIn) {
    return null;
  }

  return <>{children}</>;
}

const PAGE_WITH_REQUIRED_ROLE: Record<string, Role> = {
  "/settings": "admin",
};
