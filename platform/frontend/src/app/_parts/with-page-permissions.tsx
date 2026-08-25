"use client";

import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { usePathname } from "next/navigation";
import type React from "react";
import { ForbiddenPage } from "@/app/_parts/forbidden-page";
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

  // No loader while the permission check is in flight. It used to render one
  // here, inside the shell and centred on the content column — a different
  // spot from the boot loader that had just been on screen, so the two read as
  // the indicator jumping across the page. The sidebar toggle carries the
  // progress; the content area simply stays empty until we know whether this
  // page is even allowed.
  if (isPending && requiredPermissions) {
    return null;
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
