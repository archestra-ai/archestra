"use client";

import { E2eTestId, type Permissions } from "@archestra/shared";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";

/**
 * Canonical parse of the `adminView` URL param. Absent or anything other
 * than the literal "true" means the admin view is off.
 */
export function isAdminViewEnabled(searchParams: URLSearchParams): boolean {
  return searchParams.get("adminView") === "true";
}

/**
 * Builds the URL params for toggling the admin view. ON sets
 * `adminView=true`; OFF removes it along with the narrowing filters the
 * non-admin view can't display (`authorIds`, `excludeAuthorIds`,
 * `teamIds`). Both directions reset pagination. Does not mutate `current`.
 */
export function buildAdminViewToggleParams(
  current: URLSearchParams,
  enabled: boolean,
): URLSearchParams {
  const params = new URLSearchParams(current.toString());
  if (enabled) {
    params.set("adminView", "true");
  } else {
    params.delete("adminView");
    params.delete("authorIds");
    params.delete("excludeAuthorIds");
    params.delete("teamIds");
  }
  params.set("page", "1");
  return params;
}

/**
 * "View as admin" toggle for resource-list pages. Renders only for users
 * holding `adminPermission`; state lives in the `adminView` URL param.
 */
export function AdminViewToggle({
  adminPermission,
}: {
  adminPermission: Permissions;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const { data: isAdmin } = useHasPermissions(adminPermission);

  const adminView = isAdminViewEnabled(searchParams);

  const handleCheckedChange = useCallback(
    (checked: boolean) => {
      const params = buildAdminViewToggleParams(searchParams, checked);
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  if (!isAdmin) return null;

  return (
    <div className="flex items-center gap-2">
      <Switch
        id="admin-view-toggle"
        checked={adminView}
        onCheckedChange={handleCheckedChange}
        data-testid={E2eTestId.AdminViewToggle}
      />
      <Label htmlFor="admin-view-toggle" className="font-normal">
        View as admin
      </Label>
    </div>
  );
}
