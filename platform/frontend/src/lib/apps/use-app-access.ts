// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { archestraApiTypes, ScopedPermission } from "@archestra/shared";
import { useMemo } from "react";
import { useScopedCapabilities } from "@/lib/auth/auth.query";
import { notYoursToChange } from "@/lib/design/resource-lexicon";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];
type OwnedApp = Extract<AppListItem, { source: "owned" }>;

export interface AppAccessContext {
  scopedGrants: readonly ScopedPermission[];
  isPending: boolean;
}

/**
 * Resolve what the caller may do to one owned app. App update and delete are
 * granted per app (or `*`) by the backend's scoped grants, never by role.
 */
export function computeAppAccess(
  app: { id?: string } | null | undefined,
  context: AppAccessContext,
) {
  const actions = context.scopedGrants
    .filter(
      (grant) =>
        grant.resource === "app" &&
        (grant.scope === "*" ||
          (app?.id !== undefined && grant.scope === app.id)),
    )
    .map((grant) => grant.action);
  const canEdit = actions.includes("update");
  const canDeleteApp = actions.includes("delete");
  return { isPending: context.isPending, canEdit, canDeleteApp };
}

export function appActionDisabledReason({
  app,
  access,
  action,
}: {
  app: Pick<OwnedApp, "scope">;
  access: ReturnType<typeof computeAppAccess>;
  action: "update" | "delete";
}): string | undefined {
  if (access.isPending) return "Checking permissions…";
  const allowed = action === "update" ? access.canEdit : access.canDeleteApp;
  return allowed
    ? undefined
    : notYoursToChange({ resource: "app", scope: app.scope });
}

/** Fetch the caller-level facts once for collections such as the Apps table. */
export function useAppAccessContext(): AppAccessContext {
  const { data, isPending } = useScopedCapabilities();
  return useMemo(
    () => ({ scopedGrants: data ?? EMPTY_GRANTS, isPending }),
    [data, isPending],
  );
}

export function useAppAccess(app: { id?: string } | null | undefined) {
  return computeAppAccess(app, useAppAccessContext());
}

const EMPTY_GRANTS: readonly ScopedPermission[] = [];
