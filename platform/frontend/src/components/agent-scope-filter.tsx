"use client";

import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  LabelFilterBadges,
  LabelKeyRowBase,
  LabelSelect,
  parseLabelsParam,
  serializeLabels,
} from "@/components/label-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLabelKeys, useLabelValues } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/team.query";

type ScopeValue =
  | "personal"
  | "my_personal"
  | "others_personal"
  | "team"
  | "org"
  | "built_in";

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

  const excludeAuthorIdsParam = searchParams.get("excludeAuthorIds");

  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  // Derive the UI scope from URL params
  const uiScope: ScopeValue | undefined = useMemo(() => {
    if (scope !== "personal") return scope;
    if (excludeAuthorIdsParam) return "others_personal";
    if (!authorIdsParam) return "my_personal";
    if (currentUserId) {
      const ids = authorIdsParam.split(",");
      if (ids.length === 1 && ids[0] === currentUserId) {
        return "my_personal";
      }
    }
    return "others_personal";
  }, [scope, authorIdsParam, excludeAuthorIdsParam, currentUserId]);

  const selectedTeamIds = useMemo(
    () => (teamIdsParam ? teamIdsParam.split(",") : []),
    [teamIdsParam],
  );
  const selectedAuthorIds = useMemo(
    () => (authorIdsParam ? authorIdsParam.split(",") : []),
    [authorIdsParam],
  );

  const nameFilter = searchParams.get("name");
  const labelsParam = searchParams.get("labels");
  const hasActiveFilters = !!(
    scope ||
    teamIdsParam ||
    authorIdsParam ||
    excludeAuthorIdsParam ||
    nameFilter ||
    labelsParam
  );

  const { data: labelKeys } = useLabelKeys();
  const { data: isAdmin } = useHasPermissions({ member: ["read"] });
  const { data: teams } = useTeams();
  const { data: members } = useOrganizationMembers(
    !!isAdmin && uiScope === "others_personal",
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
      if (value === "my_personal") {
        updateUrlParams({
          scope: "personal",
          teamIds: null,
          authorIds: currentUserId ?? null,
          excludeAuthorIds: null,
        });
      } else if (value === "others_personal") {
        updateUrlParams({
          scope: "personal",
          teamIds: null,
          authorIds: null,
          excludeAuthorIds: currentUserId ?? null,
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

  const handleClearAll = useCallback(() => {
    onClearSearch?.();
    updateUrlParams({
      scope: null,
      teamIds: null,
      authorIds: null,
      excludeAuthorIds: null,
      name: null,
      labels: null,
    });
  }, [updateUrlParams, onClearSearch]);

  const teamItems = useMemo(
    () => (teams ?? []).map((t) => ({ value: t.id, label: t.name })),
    [teams],
  );

  const memberItems = useMemo(
    () =>
      (members ?? [])
        .filter((m) => m.id !== currentUserId)
        .map((m) => ({
          value: m.id,
          label: m.name || m.email,
        })),
    [members, currentUserId],
  );

  return (
    <div className="flex items-center gap-2">
      <Select value={uiScope ?? "all"} onValueChange={handleScopeChange}>
        <SelectTrigger className="w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" align="start">
          <SelectItem value="all">All types</SelectItem>
          <SelectItem value="my_personal">My Personal</SelectItem>
          {isAdmin && (
            <SelectItem value="others_personal">Others' Personal</SelectItem>
          )}
          <SelectItem value="team">Team</SelectItem>
          <SelectItem value="org">Organization</SelectItem>
          {showBuiltIn && isAdmin && (
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
          selectedSuffix={(n) => `${n === 1 ? "team" : "teams"} selected`}
        />
      )}
      {uiScope === "others_personal" && isAdmin && (
        <MultiSelect
          value={selectedAuthorIds}
          onValueChange={handleAuthorIdsChange}
          items={memberItems}
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

export function ActiveFilterBadges() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const teamIdsParam = searchParams.get("teamIds");
  const authorIdsParam = searchParams.get("authorIds");
  const excludeAuthorIdsParam = searchParams.get("excludeAuthorIds");
  const labelsParam = searchParams.get("labels");
  const scopeParam = searchParams.get("scope");
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: teams } = useTeams();
  const { data: isAdmin } = useHasPermissions({ member: ["read"] });

  // Determine if this is "others' personal" — mirrors uiScope derivation in AgentScopeFilter
  const isOthersPersonal = useMemo(() => {
    if (scopeParam !== "personal") return false;
    if (excludeAuthorIdsParam) return true;
    if (!authorIdsParam) return false;
    if (currentUserId) {
      const ids = authorIdsParam.split(",");
      if (ids.length === 1 && ids[0] === currentUserId) return false;
    }
    return true;
  }, [scopeParam, authorIdsParam, excludeAuthorIdsParam, currentUserId]);

  const { data: members } = useOrganizationMembers(
    !!isAdmin && isOthersPersonal,
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
  const hasUsers = isOthersPersonal && selectedUsers.length > 0;
  const hasLabels = parsedLabels && Object.keys(parsedLabels).length > 0;

  if (!hasTeams && !hasUsers && !hasLabels) return null;

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
