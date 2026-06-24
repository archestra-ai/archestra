"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserSearchableMultiSelect } from "@/components/user-searchable-multi-select";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";

type ScopeValue = "personal" | "team" | "org";
type OwnerValue = "mine" | "others";

/**
 * Projects-list scope filter, mirroring the Agents page. Scope is the project's
 * share visibility — Personal (private) / Team (shared with teams) / Org
 * (org-wide). A `project:admin` additionally gets a "My / Other users"
 * sub-filter under Personal and can narrow to specific owners.
 */
export function ProjectScopeFilter() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const scope = (searchParams.get("scope") as ScopeValue | null) ?? undefined;
  const teamIdsParam = searchParams.get("teamIds");
  const authorIdsParam = searchParams.get("authorIds");
  const excludeAuthorIdsParam = searchParams.get("excludeAuthorIds");

  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

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
  const { data: teams } = useTeams({ enabled: !!canReadTeams });

  const ownerFilter: OwnerValue = useMemo(() => {
    if (scope !== "personal" || !isProjectAdmin) return "mine";
    if (excludeAuthorIdsParam) return "others";
    if (!authorIdsParam) return "mine";
    if (currentUserId) {
      const ids = authorIdsParam.split(",");
      if (ids.length === 1 && ids[0] === currentUserId) return "mine";
    }
    return "others";
  }, [
    scope,
    isProjectAdmin,
    authorIdsParam,
    excludeAuthorIdsParam,
    currentUserId,
  ]);

  const showOwnerSelect = scope === "personal" && !!isProjectAdmin;
  const showMembersMultiSelect = showOwnerSelect && ownerFilter === "others";
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
      if (value === "personal") {
        // Default the owner sub-filter to "My projects".
        updateUrlParams({
          scope: "personal",
          teamIds: null,
          authorIds: currentUserId ?? null,
          excludeAuthorIds: null,
        });
      } else {
        updateUrlParams({
          scope: value === "all" ? null : value,
          teamIds: null,
          authorIds: null,
          excludeAuthorIds: null,
        });
      }
    },
    [updateUrlParams, currentUserId],
  );

  const handleOwnerChange = useCallback(
    (value: string) => {
      if (value === "mine") {
        updateUrlParams({
          authorIds: currentUserId ?? null,
          excludeAuthorIds: null,
        });
      } else {
        updateUrlParams({
          authorIds: null,
          excludeAuthorIds: currentUserId ?? null,
        });
      }
    },
    [updateUrlParams, currentUserId],
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
        excludeAuthorIds: values.length > 0 ? null : (currentUserId ?? null),
      });
    },
    [updateUrlParams, currentUserId],
  );

  const teamItems = useMemo(
    () => (teams ?? []).map((t) => ({ value: t.id, label: t.name })),
    [teams],
  );
  const userOptions = useMemo(
    () =>
      (members ?? [])
        .filter((m) => m.id !== currentUserId)
        .map((m) => ({ userId: m.id, name: m.name, email: m.email })),
    [members, currentUserId],
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
      {showOwnerSelect && (
        <Select value={ownerFilter} onValueChange={handleOwnerChange}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start">
            <SelectItem value="mine">My projects</SelectItem>
            <SelectItem value="others">Other users</SelectItem>
          </SelectContent>
        </Select>
      )}
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
