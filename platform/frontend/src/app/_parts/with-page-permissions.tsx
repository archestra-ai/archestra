"use client";

import { ManagedResourceSchema } from "@archestra/shared";
import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { usePathname } from "next/navigation";
import type React from "react";
import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import {
  isSettingsAreaPath,
  settingsAreaFallbackUrl,
} from "@/app/_parts/settings-navigation";
import { useSettingsAreaAccess } from "@/app/_parts/use-settings-area-access";
import { ClientRedirect } from "@/components/client-redirect";
import {
  useAllPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import { hasPagePermissions } from "@/lib/auth/auth.utils";

export const WithPagePermissions: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const pathname = usePathname();

  // Get required permissions for current page
  const requiredPermissions = resolvePagePermissions(pathname);
  // Scoped capabilities only matter for a read on a resource with object
  // grants; any other page is decided by role permissions alone, so it does
  // not wait for them.
  const needsCapabilities = Object.entries(requiredPermissions ?? {}).some(
    ([resource, actions]) =>
      actions.includes("read") &&
      ManagedResourceSchema.safeParse(resource).success,
  );
  const permissions = useAllPermissions();
  const capabilities = useScopedCapabilities(needsCapabilities);
  const hasRequiredPermissions = hasPagePermissions({
    userPermissions: permissions.data,
    required: requiredPermissions ?? {},
    capabilities: capabilities.data ?? [],
  });
  const isPending =
    permissions.isPending || (needsCapabilities && capabilities.isPending);
  const canSeeSettings = useSettingsAreaAccess();

  // No loader while the permission check is in flight. It used to render one
  // here, inside the shell and centred on the content column — a different
  // spot from the boot loader that had just been on screen, so the two read as
  // the indicator jumping across the page. The sidebar toggle carries the
  // progress; the content area simply stays empty until we know whether this
  // page is even allowed.
  if (isPending && requiredPermissions) {
    return null;
  }

  // A reader without the Settings area (the member baseline) is sent to the
  // personal page that holds what they came for, before any Settings page —
  // or a Forbidden page — renders.
  if (isSettingsAreaPath(pathname)) {
    if (canSeeSettings === null) return null;
    if (!canSeeSettings) {
      const fallback = settingsAreaFallbackUrl(pathname);
      // Credentials links carry state in the query (filters, GitHub connect
      // results); Personal Settings → Credentials reads the same parameters.
      return (
        <ClientRedirect
          to={fallback}
          keepQuery={fallback === "/account/credentials"}
        />
      );
    }
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
