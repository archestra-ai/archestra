"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { isAdminViewEnabled } from "@/components/admin-view-toggle";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserSearchableMultiSelect } from "@/components/user-searchable-multi-select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";

type ScopeValue = "personal" | "team" | "org";

/**
 * Projects-list scope filter, mirroring the Agents page. Scope is the project's
 * share visibility — Personal (private) / Team (shared with teams) / Org
 * (org-wide). When the "View as admin" toggle is on (`adminView=true` in the
 * URL), a `project:admin` additionally gets a user multi-select to narrow to
 * specific owners.
 */
export function ProjectScopeFilter() {
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

  const { data: isProjectAdmin } = useHasPermissions({ project: ["admin"] });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  // Admins browsing without the admin view only see resources of teams they
  // belong to, so scope the picker to membership; the admin view (and the
  // unchanged non-admin path, where `mine` has no effect) lists all teams.
  // Member view: membership-scoped picker for everyone; admin view: all teams.
  const { data: teams } = useTeams({
    enabled: !!canReadTeams,
    mine: !(adminView && !!isProjectAdmin),
  });

  const showMembersMultiSelect = adminView && !!isProjectAdmin;
  const { data: members } = useOrganizationMembers(showMembersMultiSelect);

  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      }
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
      updateUrlParams({ teamIds: values.length > 0 ? values.join(",") : null });
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
        <SelectTrigger className="w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" align="start">
          <SelectItem value="all">All projects</SelectItem>
          <SelectItem value="personal">Personal</SelectItem>
          <SelectItem value="team" disabled={!canReadTeams}>
            Team
          </SelectItem>
          <SelectItem value="org">Organization</SelectItem>
        </SelectContent>
      </Select>
      {scope === "team" && canReadTeams && teamItems.length > 0 && (
        <MultiSelect
          value={selectedTeamIds}
          onValueChange={handleTeamIdsChange}
          items={teamItems}
          placeholder="All teams"
          className="w-[200px]"
          showSelectedBadges={false}
          selectedSuffix={(n) => `${n === 1 ? "team" : "teams"} selected`}
        />
      )}
      {showMembersMultiSelect && (
        <UserSearchableMultiSelect
          value={selectedAuthorIds}
          onValueChange={handleAuthorIdsChange}
          users={userOptions}
          placeholder="All users"
          className="w-[200px]"
          showSelectedBadges={false}
          selectedSuffix={(n) => `${n === 1 ? "user" : "users"} selected`}
        />
      )}
    </div>
  );
}
