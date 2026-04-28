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
import { useLabelKeys, useLabelValues } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";

type ScopeValue = "personal" | "team" | "org" | "built_in";
type OwnerValue = "mine" | "others";

export function AgentScopeFilter({
  showBuiltIn = false,
  ownerLabelPlural = "agents",
}: {
  showBuiltIn?: boolean;
  ownerLabelPlural?: string;
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

  const selectedTeamIds = useMemo(
    () => (teamIdsParam ? teamIdsParam.split(",") : []),
    [teamIdsParam],
  );
  const selectedAuthorIds = useMemo(
    () => (authorIdsParam ? authorIdsParam.split(",") : []),
    [authorIdsParam],
  );

  const { data: labelKeys } = useLabelKeys();
  const { data: isAdmin } = useHasPermissions({ member: ["read"] });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: teams } = useTeams({ enabled: !!canReadTeams });

  const ownerFilter: OwnerValue = useMemo(() => {
    if (scope !== "personal" || !isAdmin) return "mine";
    if (excludeAuthorIdsParam) return "others";
    if (!authorIdsParam) return "mine";
    if (currentUserId) {
      const ids = authorIdsParam.split(",");
      if (ids.length === 1 && ids[0] === currentUserId) return "mine";
    }
    return "others";
  }, [scope, isAdmin, authorIdsParam, excludeAuthorIdsParam, currentUserId]);

  const showOwnerSelect = scope === "personal" && !!isAdmin;
  const showMembersMultiSelect = showOwnerSelect && ownerFilter === "others";

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
      if (value === "personal") {
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
        excludeAuthorIds: values.length > 0 ? null : (currentUserId ?? null),
      });
    },
    [updateUrlParams, currentUserId],
  );

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
      {showOwnerSelect && (
        <Select value={ownerFilter} onValueChange={handleOwnerChange}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start">
            <SelectItem value="mine">My {ownerLabelPlural}</SelectItem>
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
    </div>
  );
}

export function ActiveFilterBadges() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const teamIdsParam = searchParams.get("teamIds");
  const authorIdsParam = searchParams.get("authorIds");
  const labelsParam = searchParams.get("labels");
  const scopeParam = searchParams.get("scope");
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: teams } = useTeams({ enabled: !!canReadTeams });
  const { data: isAdmin } = useHasPermissions({ member: ["read"] });

  // Users badge only shows when the author filter names specific other users,
  // not when it's just the implicit "mine" selection.
  const showsSpecificOtherUsers = useMemo(() => {
    if (scopeParam !== "personal") return false;
    if (!authorIdsParam) return false;
    if (!currentUserId) return authorIdsParam.length > 0;
    const ids = authorIdsParam.split(",");
    if (ids.length === 1 && ids[0] === currentUserId) return false;
    return true;
  }, [scopeParam, authorIdsParam, currentUserId]);

  const { data: members } = useOrganizationMembers(
    !!isAdmin && showsSpecificOtherUsers,
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
        params.delete("excludeAuthorIds");
      } else {
        params.delete("authorIds");
        if (currentUserId) {
          params.set("excludeAuthorIds", currentUserId);
        }
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [authorIdsParam, searchParams, router, pathname, currentUserId],
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
  const hasUsers = showsSpecificOtherUsers && selectedUsers.length > 0;
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
