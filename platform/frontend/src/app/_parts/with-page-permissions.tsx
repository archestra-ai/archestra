"use client";

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
import { useHasPagePermissions } from "@/lib/auth/auth.query";

export const WithPagePermissions: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const pathname = usePathname();

  // Get required permissions for current page
  const requiredPermissions = resolvePagePermissions(pathname);
  const { data: hasRequiredPermissions, isPending } = useHasPagePermissions(
    requiredPermissions || {},
  );
  const canSeeSettings = useSettingsAreaAccess();

  // No loader while the permission check is in flight. It used to render one
  // here, inside the shell and centred on the content column — a different
  // spot from the boot loader that had just been on screen, so the two read as
  // the indicator jumping across the page. The sidebar toggle carries the
  // progress; the content area simply stays empty until we know whether this
  // page is even allowed.
  //
  // Chat is the exception: it is what nearly every visitor opens first, and
  // almost everyone may use it, so it renders while the check runs and gives
  // way to the Forbidden page only if the answer is "no chat:read".
  if (isPending && requiredPermissions) {
    return isOptimisticChatPath(pathname) ? <>{children}</> : null;
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

/** New chat and a conversation; not the other pages under /chat. */
function isOptimisticChatPath(pathname: string) {
  if (pathname === "/chat") return true;
  const segment = /^\/chat\/([^/]+)$/.exec(pathname)?.[1];
  return !!segment && !NON_CONVERSATION_CHAT_SEGMENTS.has(segment);
}

const NON_CONVERSATION_CHAT_SEGMENTS = new Set(["new", "runs"]);

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
