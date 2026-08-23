"use client";

import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { usePathname } from "next/navigation";
import type React from "react";
import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { LoadingState } from "@/components/loading";
import { useHasPermissions } from "@/lib/auth/auth.query";

export const WithPagePermissions: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const pathname = usePathname();

  // Get required permissions for current page
  const requiredPermissions = resolvePagePermissions(pathname);
  const { data: hasRequiredPermissions, isPending } = useHasPermissions(
    requiredPermissions || {},
  );

  // Show loading while checking permissions
  if (isPending && requiredPermissions) {
    return <LoadingState label="Checking access…" variant="page" />;
  }

  // Show forbidden page if user doesn't have required permissions
  if (requiredPermissions && !hasRequiredPermissions) {
    return <ForbiddenPage />;
  }

  return <>{children}</>;
};

function resolvePagePermissions(pathname: string) {
  const exact = requiredPagePermissionsMap[pathname];
  if (exact) return exact;
  const pathSegments = pathname.split("/").filter(Boolean);
  for (const [pattern, permissions] of Object.entries(
    requiredPagePermissionsMap,
  )) {
    const patternSegments = pattern.split("/").filter(Boolean);
    if (patternSegments.length !== pathSegments.length) continue;
    const matches = patternSegments.every(
      (segment, index) =>
        (/^\[[^/]+\]$/.test(segment) && !!pathSegments[index]) ||
        segment === pathSegments[index],
    );
    if (matches) return permissions;
  }
  return undefined;
}
