"use client";

import type { Permissions } from "@shared";
import { usePathname, useRouter } from "next/navigation";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { hasPermission } from "@/lib/auth.utils";
import { authClient } from "@/lib/clients/auth/auth-client";

export function WithAuthCheck({
  children,
}: {
  children: ReactElement;
}): ReactElement | null {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending: isAuthCheckPending } =
    authClient.useSession();

  const isAuthPage =
    pathname?.startsWith("/auth/sign-in") ||
    pathname?.startsWith("/auth/sign-up") ||
    pathname?.startsWith("/auth/two-factor");

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
    const hasPermissions = hasPermission(
      PAGE_WITH_REQUIRED_PERMISSION[pathname],
    );

    const requiredPermissions = PAGE_WITH_REQUIRED_PERMISSION[pathname];
    if (requiredPermissions && !hasPermissions) {
      router.push("/");
    }
  }, [isAuthCheckPending, pathname, router]);

  if (isAuthCheckPending) {
    return null;
  }

  // During redirect, show nothing
  if (isAuthPageAndUserLoggedIn || isNotAuthPageAndUserNotLoggedIn) {
    return null;
  }

  return <>{children}</>;
}

const PAGE_WITH_REQUIRED_PERMISSION: Record<string, Permissions> = {
  "/gateways": {
    mcpServer: ["read"],
  },
};
