"use client";

import { requiredPagePermissionsMap } from "@shared";
import { usePathname, useRouter } from "next/navigation";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { hasPermission } from "@/lib/auth.utils";
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
  const [checkingPermissions, setCheckingPermissions] = useState<boolean>(true);
  const { data: session, isPending: isAuthCheckPending } =
    authClient.useSession();

  const isLoggedIn = session?.user;
  const isAuthPage = pathCorrespondsToAnAuthPage(pathname);
  const isAuthPageAndUserLoggedIn = isAuthPage && isLoggedIn;
  const isNotAuthPageAndUserNotLoggedIn = !isAuthPage && !isLoggedIn;

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
    (async () => {
      setCheckingPermissions(true);
      try {
        const requiredPermissions = requiredPagePermissionsMap[pathname];

        if (isAuthCheckPending) {
          return;
        } else if (!requiredPermissions) {
          return;
        }

        if (!(await hasPermission(requiredPermissions))) {
          router.push("/");
        }
      } catch (_error) {
        console.error(_error);
      } finally {
        setCheckingPermissions(false);
      }
    })();
  }, [isAuthCheckPending, pathname, router]);

  if (isAuthCheckPending) {
    return null;
  }

  // During redirect, show nothing
  if (
    isAuthPageAndUserLoggedIn ||
    isNotAuthPageAndUserNotLoggedIn ||
    checkingPermissions
  ) {
    return null;
  }

  return <>{children}</>;
}
