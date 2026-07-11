"use client";

import type { Permissions } from "@archestra/shared";
import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { isAdminViewEnabled } from "@/components/admin-view-toggle";
import {
  LabelFilterBadges,
  LabelKeyRowBase,
  LabelSelect,
  parseLabelsParam,
  serializeLabels,
} from "@/components/label-select";
import { PermissionRequirementHint } from "@/components/permission-requirement-hint";
import { Badge } from "@/components/ui/badge";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserSearchableMultiSelect } from "@/components/user-searchable-multi-select";
import { useLabelKeys, useLabelValues } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";

type ScopeValue = "personal" | "team" | "org" | "built_in";
type StatusValue = "active" | "deleted";

export function AgentScopeFilter({
  showBuiltIn = false,
  adminPermission,
}: {
  showBuiltIn?: boolean;
  adminPermission: Permissions;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const scope = (searchParams.get("scope") as ScopeValue | null) ?? undefined;
  const teamIdsParam = searchParams.get("teamIds");
  const authorIdsParam = searchParams.get("authorIds");
  const adminView = isAdminViewEnabled(searchParams);

  const selectedTeamIds = useMemo(
    () => (teamIdsParam ? teamIdsParam.split(",") : []),
    [teamIdsParam],
  );
  const selectedAuthorIds = useMemo(
    () => (authorIdsParam ? authorIdsParam.split(",") : []),
    [authorIdsParam],
  );

  const { data: labelKeys } = useLabelKeys();
  const { data: isAdmin } = useHasPermissions(adminPermission);
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  // Admins browsing without the admin view only see resources of teams they
  // belong to, so scope the picker to membership; the admin view (and the
  // unchanged non-admin path, where `mine` has no effect) lists all teams.
  const { data: teams } = useTeams({
    enabled: !!canReadTeams,
    mine: !!isAdmin && !adminView,
  });

  const showMembersMultiSelect = adminView && !!isAdmin;

  const { data: members } = useOrganizationMembers(showMembersMultiSelect);

  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const handleScopeChange = useCallback(
    (value: string) => {
      updateUrlParams({
        scope: value === "all" ? null : value,
        teamIds: null,
        authorIds: null,
      });
    },
    [updateUrlParams],
  );

  const handleTeamIdsChange = useCallback(
    (values: string[]) => {
      updateUrlParams({
        teamIds: values.length > 0 ? values.join(",") : null,
      });
    },
    [updateUrlParams],
  );

  const handleAuthorIdsChange = useCallback(
    (values: string[]) => {
      updateUrlParams({
        authorIds: values.length > 0 ? values.join(",") : null,
      });
    },
    [updateUrlParams],
  );

  const teamItems = useMemo(
    () => (teams ?? []).map((t) => ({ value: t.id, label: t.name })),
    [teams],
  );

  const userOptions = useMemo(
    () =>
      (members ?? []).map((m) => ({
        userId: m.id,
        name: m.name,
        email: m.email,
      })),
    [members],
  );

  return (
    <div className="flex items-center gap-2">
      <Select value={scope ?? "all"} onValueChange={handleScopeChange}>
        <SelectTrigger className="w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" align="start">
          <SelectItem value="all">All types</SelectItem>
          <SelectItem value="personal">Personal</SelectItem>
          <SelectItem value="team" disabled={!canReadTeams}>
            Team
          </SelectItem>
          <SelectItem value="org">Organization</SelectItem>
          {showBuiltIn && isAdmin && (
            <>
              <SelectSeparator />
              <SelectItem value="built_in">Built-in</SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      {scope === "team" && canReadTeams && teamItems.length > 0 && (
        <MultiSelect
          value={selectedTeamIds}
          onValueChange={handleTeamIdsChange}
          items={teamItems}
          placeholder="All teams"
          className="w-[220px]"
          showSelectedBadges={false}
          selectedSuffix={(n) => `${n === 1 ? "team" : "teams"} selected`}
        />
      )}
      {scope === "team" && !canReadTeams && (
        <PermissionRequirementHint
          message="Team filters are unavailable without"
          permissions={[{ resource: "team", action: "read" }]}
          className="inline"
        />
      )}
      {showMembersMultiSelect && (
        <UserSearchableMultiSelect
          value={selectedAuthorIds}
          onValueChange={handleAuthorIdsChange}
          users={userOptions}
          placeholder="All users"
          className="w-[220px]"
          showSelectedBadges={false}
          selectedSuffix={(n) => `${n === 1 ? "user" : "users"} selected`}
        />
      )}
      <LabelSelect
        labelKeys={labelKeys}
        LabelKeyRowComponent={AgentLabelKeyRow}
      />
    </div>
  );
}

export function AgentDeletedStatusFilter({
  deletePermission,
}: {
  deletePermission: Permissions;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { data: canDelete } = useHasPermissions(deletePermission);

  const status = (searchParams.get("status") as StatusValue | null) ?? "active";

  const handleStatusChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "deleted") {
        params.set("status", "deleted");
      } else {
        params.delete("status");
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  if (!canDelete) return null;

  return (
    <Select value={status} onValueChange={handleStatusChange}>
      <SelectTrigger className="w-[150px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" side="bottom" align="start">
        <SelectItem value="active">Active</SelectItem>
        <SelectItem value="deleted">Deleted</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function ActiveFilterBadges({
  adminPermission,
}: {
  adminPermission: Permissions;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const teamIdsParam = searchParams.get("teamIds");
  const authorIdsParam = searchParams.get("authorIds");
  const labelsParam = searchParams.get("labels");
  const adminView = isAdminViewEnabled(searchParams);
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: teams } = useTeams({ enabled: !!canReadTeams });
  const { data: isAdmin } = useHasPermissions(adminPermission);

  const { data: members } = useOrganizationMembers(
    !!isAdmin && adminView && !!authorIdsParam,
  );

  const selectedTeams = useMemo(() => {
    if (!teamIdsParam || !teams) return [];
    const ids = teamIdsParam.split(",");
    return teams.filter((t) => ids.includes(t.id));
  }, [teamIdsParam, teams]);

  const selectedUsers = useMemo(() => {
    if (!authorIdsParam || !members) return [];
    const ids = authorIdsParam.split(",");
    return members.filter((m) => ids.includes(m.id));
  }, [authorIdsParam, members]);

  const parsedLabels = useMemo(
    () => parseLabelsParam(labelsParam),
    [labelsParam],
  );

  const handleRemoveTeam = useCallback(
    (teamId: string) => {
      const ids = (teamIdsParam ?? "").split(",").filter((id) => id !== teamId);
      const params = new URLSearchParams(searchParams.toString());
      if (ids.length > 0) {
        params.set("teamIds", ids.join(","));
      } else {
        params.delete("teamIds");
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [teamIdsParam, searchParams, router, pathname],
  );

  const handleRemoveUser = useCallback(
    (userId: string) => {
      const ids = (authorIdsParam ?? "")
        .split(",")
        .filter((id) => id !== userId);
      const params = new URLSearchParams(searchParams.toString());
      if (ids.length > 0) {
        params.set("authorIds", ids.join(","));
      } else {
        params.delete("authorIds");
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [authorIdsParam, searchParams, router, pathname],
  );

  const handleRemoveLabel = useCallback(
    (key: string, value: string) => {
      if (!parsedLabels) return;
      const updated = { ...parsedLabels };
      updated[key] = updated[key].filter((v) => v !== value);
      if (updated[key].length === 0) {
        delete updated[key];
      }
      const params = new URLSearchParams(searchParams.toString());
      const serialized = serializeLabels(updated);
      if (serialized) {
        params.set("labels", serialized);
      } else {
        params.delete("labels");
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [parsedLabels, searchParams, router, pathname],
  );

  const hasTeams = selectedTeams.length > 0;
  const hasUnavailableTeamsFilter = !!teamIdsParam && !canReadTeams;
  const hasUsers = adminView && selectedUsers.length > 0;
  const hasLabels = parsedLabels && Object.keys(parsedLabels).length > 0;

  if (!hasTeams && !hasUsers && !hasLabels && !hasUnavailableTeamsFilter)
    return null;

  return (
    <div className="flex flex-col gap-1.5">
      {hasTeams && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Teams</span>
          {selectedTeams.map((team) => (
            <Badge
              key={team.id}
              variant="outline"
              className="gap-1 pr-1 bg-green-500/10 text-green-600 border-green-500/30"
            >
              {team.name}
              <button
                type="button"
                onClick={() => handleRemoveTeam(team.id)}
                className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      {hasUnavailableTeamsFilter && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Teams</span>
          <Badge variant="outline" className="text-muted-foreground">
            Unavailable
          </Badge>
        </div>
      )}
      {hasUsers && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground">Users</span>
          {selectedUsers.map((user) => (
            <Badge
              key={user.id}
              variant="outline"
              className="gap-1 pr-1 bg-blue-500/10 text-blue-600 border-blue-500/30"
            >
              {user.name || user.email}
              <button
                type="button"
                onClick={() => handleRemoveUser(user.id)}
                className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      {hasLabels && <LabelFilterBadges onRemoveLabel={handleRemoveLabel} />}
    </div>
  );
}

function AgentLabelKeyRow({
  labelKey,
  selectedValues,
  onToggleValue,
}: {
  labelKey: string;
  selectedValues: string[];
  onToggleValue: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: values } = useLabelValues({ key: open ? labelKey : undefined });
  return (
    <LabelKeyRowBase
      labelKey={labelKey}
      selectedValues={selectedValues}
      onToggleValue={onToggleValue}
      values={values}
      onOpenChange={setOpen}
    />
  );
}
