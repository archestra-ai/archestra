"use client";

import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/multi-select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/team.query";

type ScopeValue = "personal" | "team" | "org" | "built_in";

export function AgentScopeFilter({
  showBuiltIn = false,
  onClearSearch,
}: {
  showBuiltIn?: boolean;
  onClearSearch?: () => void;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const scope = (searchParams.get("scope") as ScopeValue | null) ?? undefined;
  const teamIdsParam = searchParams.get("teamIds");
  const authorIdsParam = searchParams.get("authorIds");

  const selectedTeamIds = useMemo(
    () => (teamIdsParam ? teamIdsParam.split(",") : []),
    [teamIdsParam],
  );
  const selectedAuthorIds = useMemo(
    () => (authorIdsParam ? authorIdsParam.split(",") : []),
    [authorIdsParam],
  );

  const nameFilter = searchParams.get("name");
  const hasActiveFilters = !!(
    scope ||
    teamIdsParam ||
    authorIdsParam ||
    nameFilter
  );

  const { data: isAdmin } = useHasPermissions({ member: ["read"] });
  const { data: teams } = useTeams();
  const { data: members } = useOrganizationMembers(
    !!isAdmin && scope === "personal",
  );

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
    (value: string) => {
      updateUrlParams({
        authorIds: value === "all" ? null : value,
      });
    },
    [updateUrlParams],
  );

  const handleClearAll = useCallback(() => {
    onClearSearch?.();
    updateUrlParams({
      scope: null,
      teamIds: null,
      authorIds: null,
      name: null,
    });
  }, [updateUrlParams, onClearSearch]);

  const teamItems = useMemo(
    () => (teams ?? []).map((t) => ({ value: t.id, label: t.name })),
    [teams],
  );

  const memberItems = useMemo(
    () => [
      { value: "all", label: "All users" },
      ...(members ?? []).map((m) => ({
        value: m.id,
        label: m.name || m.email,
      })),
    ],
    [members],
  );

  return (
    <div className="flex items-center gap-2">
      <Select value={scope ?? "all"} onValueChange={handleScopeChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" align="start">
          <SelectItem value="all">All types</SelectItem>
          <SelectItem value="personal">Personal</SelectItem>
          <SelectItem value="team">Team</SelectItem>
          <SelectItem value="org">Organization</SelectItem>
          {showBuiltIn && (
            <>
              <SelectSeparator />
              <SelectItem value="built_in">Built-in</SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      {scope === "team" && teamItems.length > 0 && (
        <MultiSelect
          value={selectedTeamIds}
          onValueChange={handleTeamIdsChange}
          items={teamItems}
          placeholder="All teams"
          className="w-[220px]"
          showSelectedBadges={false}
        />
      )}
      {scope === "personal" && isAdmin && (
        <SearchableSelect
          value={selectedAuthorIds[0] ?? "all"}
          onValueChange={handleAuthorIdsChange}
          items={memberItems}
          placeholder="All users"
          className="w-[200px]"
        />
      )}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleClearAll}
          className="h-9 px-2 text-muted-foreground"
        >
          <X className="h-4 w-4 mr-1" />
          Clear
        </Button>
      )}
    </div>
  );
}
