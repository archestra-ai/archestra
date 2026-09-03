"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { computeCanModifyAgent } from "@/components/agent-pages/use-agent-access";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { formatPermissionConstraint } from "@/lib/auth/auth.utils";
import { notYoursToChange } from "@/lib/design/resource-lexicon";
import { useMyTeams } from "@/lib/teams/team.query";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];
type OwnedApp = Extract<AppListItem, { source: "owned" }>;

export interface AppAccessContext {
  isAdmin: boolean;
  isTeamAdmin: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  currentUserId: string | undefined;
  userTeamIds: ReadonlySet<string>;
  isPending: boolean;
}

/**
 * Resolve what the caller may do to one owned app. The backend applies the
 * same scope rule as agents and skills, so the frontend delegates to their
 * shared predicate instead of treating the coarse `app:update` permission as
 * sufficient on its own.
 */
export function computeAppAccess(
  app: Pick<OwnedApp, "scope" | "authorId" | "teams"> | null | undefined,
  context: AppAccessContext,
) {
  const canModify = computeCanModifyAgent({
    agent: app,
    isAdmin: context.isAdmin,
    isTeamAdmin: context.isTeamAdmin,
    currentUserId: context.currentUserId,
    userTeamIds: context.userTeamIds,
  });

  return {
    ...context,
    canModify,
    canEdit: context.canUpdate && canModify,
    canDeleteApp: context.canDelete && canModify,
  };
}

export function appActionDisabledReason({
  app,
  access,
  action,
}: {
  app: Pick<OwnedApp, "scope" | "authorId" | "teams">;
  access: ReturnType<typeof computeAppAccess>;
  action: "update" | "delete";
}): string | undefined {
  if (access.isPending) return "Checking permissions…";

  const hasPermission =
    action === "update" ? access.canUpdate : access.canDelete;
  if (!hasPermission) {
    return formatPermissionConstraint({ app: [action] });
  }
  if (!access.canModify) {
    return notYoursToChange({ resource: "app", scope: app.scope });
  }
  return undefined;
}

/** Fetch the caller-level facts once for collections such as the Apps table. */
export function useAppAccessContext(): AppAccessContext {
  const { data: isAdmin, isPending: isAdminPending } = useHasPermissions({
    app: ["admin"],
  });
  const { data: isTeamAdmin, isPending: isTeamAdminPending } =
    useHasPermissions({ app: ["team-admin"] });
  const { data: canUpdate, isPending: isUpdatePending } = useHasPermissions({
    app: ["update"],
  });
  const { data: canDelete, isPending: isDeletePending } = useHasPermissions({
    app: ["delete"],
  });
  const { data: canReadTeams, isPending: isTeamsPermissionPending } =
    useHasPermissions({ team: ["read"] });
  const { data: userTeams, isLoading: isTeamsLoading } = useMyTeams({
    enabled: !!canReadTeams,
  });
  const { data: session } = useSession();

  return {
    isAdmin: !!isAdmin,
    isTeamAdmin: !!isTeamAdmin,
    canUpdate: !!canUpdate,
    canDelete: !!canDelete,
    currentUserId: session?.user?.id,
    userTeamIds: new Set((userTeams ?? []).map((team) => team.id)),
    isPending:
      isAdminPending ||
      isTeamAdminPending ||
      isUpdatePending ||
      isDeletePending ||
      isTeamsPermissionPending ||
      isTeamsLoading,
  };
}

export function useAppAccess(
  app: Pick<OwnedApp, "scope" | "authorId" | "teams"> | null | undefined,
) {
  return computeAppAccess(app, useAppAccessContext());
}
