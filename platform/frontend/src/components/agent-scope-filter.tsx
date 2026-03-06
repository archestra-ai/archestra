"use client";

import { Check, ChevronDown, Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLabelKeys, useLabelValues } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/team.query";
import { cn } from "@/lib/utils";

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
  const labelsParam = searchParams.get("labels");
  const hasActiveFilters = !!(
    scope ||
    teamIdsParam ||
    authorIdsParam ||
    nameFilter ||
    labelsParam
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
      (members ?? []).map((m) => ({
        value: m.id,
        label: m.name || m.email,
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
          <SelectItem value="all">All types</SelectItem>
          <SelectItem value="personal">Personal</SelectItem>
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
      {scope === "personal" && isAdmin && (
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
      <LabelSelect />
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
  const labelsParam = searchParams.get("labels");
  const scopeParam = searchParams.get("scope");
  const { data: teams } = useTeams();
  const { data: isAdmin } = useHasPermissions({ member: ["read"] });
  const { data: members } = useOrganizationMembers(
    !!isAdmin && scopeParam === "personal",
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
  const hasUsers = selectedUsers.length > 0;
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
      {hasLabels && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground">Labels</span>
          {Object.entries(parsedLabels).map(([key, values]) =>
            values.map((value) => (
              <Badge
                key={`${key}:${value}`}
                variant="secondary"
                className="gap-1 pr-1"
              >
                {key}: {value}
                <button
                  type="button"
                  onClick={() => handleRemoveLabel(key, value)}
                  className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )),
          )}
        </div>
      )}
    </div>
  );
}

function LabelSelect() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [keySearch, setKeySearch] = useState("");

  const labelsParam = searchParams.get("labels");
  const parsed = useMemo(() => parseLabelsParam(labelsParam), [labelsParam]);

  const totalSelected = useMemo(() => {
    if (!parsed) return 0;
    return Object.values(parsed).reduce((sum, vals) => sum + vals.length, 0);
  }, [parsed]);

  const { data: labelKeys } = useLabelKeys();

  const filteredKeys = useMemo(() => {
    if (!labelKeys) return [];
    if (!keySearch) return labelKeys;
    const q = keySearch.toLowerCase();
    return labelKeys.filter((k) => k.toLowerCase().includes(q));
  }, [labelKeys, keySearch]);

  const updateLabels = useCallback(
    (updated: Record<string, string[]>) => {
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
    [searchParams, router, pathname],
  );

  const handleToggleValue = useCallback(
    (key: string, value: string) => {
      const current = parsed ?? {};
      const currentValues = current[key] ?? [];
      const updated = { ...current };
      if (currentValues.includes(value)) {
        updated[key] = currentValues.filter((v) => v !== value);
        if (updated[key].length === 0) delete updated[key];
      } else {
        updated[key] = [...currentValues, value];
      }
      updateLabels(updated);
    },
    [parsed, updateLabels],
  );

  if (!labelKeys || labelKeys.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "w-[180px] justify-between font-normal",
            !totalSelected && "text-muted-foreground",
          )}
        >
          <span className="truncate">
            {totalSelected > 0
              ? `${totalSelected} ${totalSelected === 1 ? "label" : "labels"} selected`
              : "Labels"}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <div className="flex items-center border-b px-3 py-2">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            placeholder="Search keys..."
            value={keySearch}
            onChange={(e) => setKeySearch(e.target.value)}
            className="flex w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[350px] overflow-y-auto p-1">
          {filteredKeys.map((key) => (
            <LabelKeyRow
              key={key}
              labelKey={key}
              selectedValues={parsed?.[key] ?? []}
              onToggleValue={handleToggleValue}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LabelKeyRow({
  labelKey,
  selectedValues,
  onToggleValue,
}: {
  labelKey: string;
  selectedValues: string[];
  onToggleValue: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data: values } = useLabelValues({ key: open ? labelKey : undefined });

  const filteredValues = useMemo(() => {
    if (!values) return [];
    if (!search) return values;
    const q = search.toLowerCase();
    return values.filter((v) => v.toLowerCase().includes(q));
  }, [values, search]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative flex w-full cursor-default select-none items-center justify-between rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
            selectedValues.length > 0 && "bg-accent/50",
          )}
        >
          <span className="truncate">{labelKey}</span>
          {selectedValues.length > 0 && (
            <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
              {selectedValues.length}
            </Badge>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[220px] p-0"
        side="right"
        align="start"
        sideOffset={4}
      >
        <div className="flex items-center border-b px-3 py-2">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            placeholder="Search values..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[250px] overflow-y-auto p-1">
          {filteredValues.length === 0 ? (
            <div className="py-4 text-center text-sm text-muted-foreground">
              {values ? "No results found." : "Loading..."}
            </div>
          ) : (
            filteredValues.map((value) => {
              const isSelected = selectedValues.includes(value);
              return (
                <button
                  type="button"
                  key={value}
                  onClick={() => onToggleValue(labelKey, value)}
                  className={cn(
                    "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                    isSelected && "bg-accent text-accent-foreground",
                  )}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      isSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{value}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function parseLabelsParam(
  labels: string | null,
): Record<string, string[]> | null {
  if (!labels) return null;
  const result: Record<string, string[]> = {};
  for (const entry of labels.split(";")) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx === -1) continue;
    const key = entry.slice(0, colonIdx).trim();
    const values = entry
      .slice(colonIdx + 1)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (key && values.length > 0) {
      result[key] = values;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function serializeLabels(labels: Record<string, string[]>): string | null {
  const entries = Object.entries(labels).filter(
    ([, values]) => values.length > 0,
  );
  if (entries.length === 0) return null;
  return entries.map(([key, values]) => `${key}:${values.join(",")}`).join(";");
}
