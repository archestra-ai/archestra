"use client";

import type { Permissions } from "@archestra/shared";
import { Braces, User, Users, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { filterControlClass } from "@/components/filter-bar";
import {
  LabelFilterBadges,
  LabelKeyRowBase,
  LabelSelect,
  parseLabelsParam,
  serializeLabels,
} from "@/components/label-select";
import { PermissionRequirementHint } from "@/components/permission-requirement-hint";
import { SCOPE_META, scopeStyles } from "@/components/scope-vocabulary";
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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { cn } from "@/lib/utils";

const SHARED_SCOPES = ["personal", "team", "org"] as const;

type SharedScopeValue = (typeof SHARED_SCOPES)[number];
type ScopeValue = SharedScopeValue | "built_in";
type OwnerValue = "mine" | "others";
type StatusValue = "active" | "deleted";
const OrganizationScopeIcon = SCOPE_META.org.icon;

/**
 * Shared Personal / Team / Organization visibility filter for resource list
 * pages (agents, MCP gateways, skills, projects, apps). Scope is
 * the resource's share visibility; state lives entirely in URL search params
 * (`scope`, `teamIds`, `authorIds`, `excludeAuthorIds`). A resource admin
 * additionally gets a "My … / Other users" sub-filter under Personal and can
 * narrow to specific owners. Read the params back with
 * {@link useScopeFilterParams} when passing them to a list API hook.
 */
export function ResourceScopeFilter({
  adminPermission,
  ownerLabelPlural,
  allLabel = "All types",
  showBuiltIn = false,
  showLabels = false,
  showTeamSelect = true,
  navigate,
}: {
  /** Admin permission unlocking the owner sub-filter, e.g. `{ skill: ["admin"] }`. */
  adminPermission: Permissions;
  /** Plural resource name for the "My …" owner option, e.g. "skills". */
  ownerLabelPlural: string;
  /** Label of the unfiltered option, e.g. "All projects". */
  allLabel?: string;
  /** Offer a "Built-in" scope to admins (agents page only). */
  showBuiltIn?: boolean;
  /** Render the agent-label filter (agent-family pages only). */
  showLabels?: boolean;
  /**
   * Offer the per-team multi-select under the Team scope and gate the Team
   * option on `team:read`. Off for resources whose list API cannot filter by
   * specific teams (apps).
   */
  showTeamSelect?: boolean;
  /** Override navigation for lists that own local URL state without an RSC round trip. */
  navigate?: (url: string) => void;
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

  const { data: isAdmin } = useHasPermissions(adminPermission);
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: teams } = useTeams({
    enabled: !!canReadTeams && showTeamSelect,
  });

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
      // reset server-side pagination (a no-op on pages without a page param)
      params.delete("page");
      const navigateTo =
        navigate ?? ((url: string) => router.push(url, { scroll: false }));
      navigateTo(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname, navigate],
  );

  const handleScopeChange = useCallback(
    (value: string) => {
      if (value === "personal") {
        // Default the owner sub-filter to "My …".
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
        // "Other users" with no specific pick = everyone except me.
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

  const userOptions = useMemo(
    () =>
      (members ?? [])
        .filter((m) => m.id !== currentUserId)
        .map((m) => ({
          userId: m.id,
          name: m.name,
          email: m.email,
        })),
    [members, currentUserId],
  );
  const selectedScopeMeta =
    scope && scope !== "built_in" ? SCOPE_META[scope] : null;
  const SelectedScopeIcon = selectedScopeMeta?.icon;

  return (
    // Wraps: at a phone width the selects below overflow one row, and this
    // group shares that row with a list page's search box, which is then
    // squeezed to its magnifier with no room left to show what was typed.
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={scope ?? "all"} onValueChange={handleScopeChange}>
        <SelectTrigger
          size="sm"
          aria-label="Filter by type"
          className={filterControlClass({ active: Boolean(scope) })}
        >
          <SelectValue>
            {selectedScopeMeta && SelectedScopeIcon ? (
              <span className="flex items-center gap-2">
                <SelectedScopeIcon className="size-4" />
                {selectedScopeMeta.label}
              </span>
            ) : scope === "built_in" ? (
              <span className="flex items-center gap-2">
                <Braces className="size-4" />
                Built-in
              </span>
            ) : (
              <span>{allLabel}</span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" align="start">
          <SelectItem value="all">{allLabel}</SelectItem>
          <SelectItem value="personal" icon={<User className="size-4" />}>
            Personal
          </SelectItem>
          <SelectItem
            value="team"
            disabled={showTeamSelect && !canReadTeams}
            icon={<Users className="size-4" />}
          >
            Team
          </SelectItem>
          <SelectItem
            value="org"
            icon={<OrganizationScopeIcon className="size-4" />}
          >
            Organization
          </SelectItem>
          {showBuiltIn && isAdmin && (
            <>
              <SelectSeparator />
              <SelectItem value="built_in" icon={<Braces className="size-4" />}>
                Built-in
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      {showOwnerSelect && (
        <Select value={ownerFilter} onValueChange={handleOwnerChange}>
          <SelectTrigger
            size="sm"
            aria-label="Filter by owner"
            className={filterControlClass({ active: ownerFilter !== "mine" })}
          >
            <SelectValue>
              <span className="flex items-center gap-2">
                {ownerFilter === "mine" ? (
                  <User className="size-4" />
                ) : (
                  <Users className="size-4" />
                )}
                {ownerFilter === "mine"
                  ? `My ${ownerLabelPlural}`
                  : "Other users"}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start">
            <SelectItem value="mine" icon={<User className="size-4" />}>
              My {ownerLabelPlural}
            </SelectItem>
            <SelectItem value="others" icon={<Users className="size-4" />}>
              Other users
            </SelectItem>
          </SelectContent>
        </Select>
      )}
      {showTeamSelect &&
        scope === "team" &&
        canReadTeams &&
        teamItems.length > 0 && (
          <MultiSelect
            value={selectedTeamIds}
            onValueChange={handleTeamIdsChange}
            items={teamItems}
            placeholder="All teams"
            className={filterControlClass({
              active: selectedTeamIds.length > 0,
            })}
            showSelectedBadges={false}
            selectedSuffix={(n) => `${n === 1 ? "team" : "teams"} selected`}
          />
        )}
      {showTeamSelect && scope === "team" && !canReadTeams && (
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
          className={filterControlClass({
            active: selectedAuthorIds.length > 0,
          })}
          contentClassName="w-80 max-w-[calc(100vw-2rem)]"
          showSelectedBadges={false}
          selectedSuffix={(n) => `${n === 1 ? "user" : "users"} selected`}
        />
      )}
      {showLabels && <AgentLabelFilter />}
    </div>
  );
}

interface ScopeFilterParams<Scope extends string> {
  scope: Scope | undefined;
  teamIds: string[] | undefined;
  authorIds: string[] | undefined;
  excludeAuthorIds: string[] | undefined;
  /**
   * Set when no personal/owner filter is active: tells the list API to hide
   * other users' personal resources from the admin default view.
   */
  excludeOtherPersonal: true | undefined;
  hasActiveScopeFilters: boolean;
}

/**
 * Read the URL params owned by {@link ResourceScopeFilter} in the shape list
 * API hooks expect. Unknown scope values are treated as unset.
 */
export function useScopeFilterParams(options: {
  includeBuiltIn: true;
}): ScopeFilterParams<ScopeValue>;
export function useScopeFilterParams(): ScopeFilterParams<SharedScopeValue>;
export function useScopeFilterParams(options?: {
  includeBuiltIn?: boolean;
}): ScopeFilterParams<ScopeValue> {
  const searchParams = useSearchParams();

  const rawScope = searchParams.get("scope");
  const allowedScopes: readonly string[] = options?.includeBuiltIn
    ? [...SHARED_SCOPES, "built_in"]
    : SHARED_SCOPES;
  const scope =
    rawScope && allowedScopes.includes(rawScope)
      ? (rawScope as ScopeValue)
      : undefined;
  const teamIdsParam = searchParams.get("teamIds");
  const authorIdsParam = searchParams.get("authorIds");
  const excludeAuthorIdsParam = searchParams.get("excludeAuthorIds");

  return {
    scope,
    teamIds: teamIdsParam ? teamIdsParam.split(",") : undefined,
    authorIds: authorIdsParam ? authorIdsParam.split(",") : undefined,
    excludeAuthorIds: excludeAuthorIdsParam
      ? excludeAuthorIdsParam.split(",")
      : undefined,
    excludeOtherPersonal:
      scope !== "personal" && !authorIdsParam && !excludeAuthorIdsParam
        ? true
        : undefined,
    hasActiveScopeFilters: !!(
      rawScope ||
      teamIdsParam ||
      authorIdsParam ||
      excludeAuthorIdsParam
    ),
  };
}

export function ResourceDeletedStatusFilter({
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
      params.delete("page");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  if (!canDelete) return null;

  return (
    <Select value={status} onValueChange={handleStatusChange}>
      <SelectTrigger
        size="sm"
        aria-label="Filter by status"
        className={filterControlClass({ active: status !== "active" })}
      >
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
  const scopeParam = searchParams.get("scope");
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: teams } = useTeams({ enabled: !!canReadTeams });
  const { data: isAdmin } = useHasPermissions(adminPermission);

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
      params.delete("page");
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
      params.delete("page");
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
      params.delete("page");
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
              className={cn(scopeStyles.team, "gap-1 pr-1")}
            >
              {team.name}
              <button
                type="button"
                onClick={() => handleRemoveTeam(team.id)}
                className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
                aria-label="Remove team from filter"
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
              className={cn(scopeStyles.personal, "gap-1 pr-1")}
            >
              {user.name || user.email}
              <button
                type="button"
                onClick={() => handleRemoveUser(user.id)}
                className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
                aria-label="Remove user from filter"
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

// The label filter is agent-specific (labels only exist on agents); keeping it
// in a child component keeps its queries out of pages that don't render it.
function AgentLabelFilter() {
  const { data: labelKeys } = useLabelKeys();
  const labelsParam = useSearchParams().get("labels");
  const hasLabels = Object.keys(parseLabelsParam(labelsParam) ?? {}).length > 0;
  return (
    <LabelSelect
      labelKeys={labelKeys}
      LabelKeyRowComponent={AgentLabelKeyRow}
      className={filterControlClass({ active: hasLabels })}
    />
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
