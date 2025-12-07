"use client";

import { usePathname } from "next/navigation";
import type React from "react";
import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { useHasPermissions } from "@/lib/auth.query";
import config from "@/lib/config";

const allowAllPages = new Proxy({} as Record<string, Record<string, string[]>>, {
  get: (_target, _prop) => ({}), // Return empty object for any page - allows all authenticated users
});

const {requiredPagePermissionsMap} = config.enterpriseLicenseActivated
  ? await import('@shared/access-control.ee')
  : await import('@shared/access-control');

export const WithPagePermissions: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const pathname = usePathname();

  // Get required permissions for current page
  const requiredPermissions = requiredPagePermissionsMap[pathname];
  const { data: hasRequiredPermissions, isPending } = useHasPermissions(
    requiredPermissions || {},
  );

  // Show loading while checking permissions
  if (isPending && requiredPermissions) {
    return null;
  }

  // Show forbidden page if user doesn't have required permissions
  if (requiredPermissions && !hasRequiredPermissions) {
    return <ForbiddenPage />;
  }

  return <>{children}</>;
};
