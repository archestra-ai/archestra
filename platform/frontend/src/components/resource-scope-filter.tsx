"use client";

import type { Permissions } from "@archestra/shared";
import { Braces } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLabelKeys, useLabelValues } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";

type StatusValue = "active" | "deleted";
type SharedScopeValue = "personal" | "team" | "org";
type ScopeValue = SharedScopeValue | "built_in";

/** Resource origin and labels are independent of who has permission to access it. */
export function ResourceScopeFilter({
  showBuiltIn = false,
  showLabels = false,
  navigate,
}: {
  ownerLabelPlural: string;
  allLabel?: string;
  showBuiltIn?: boolean;
  showLabels?: boolean;
  showTeamSelect?: boolean;
  navigate?: (url: string) => void;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const builtIn = showBuiltIn && searchParams.get("scope") === "built_in";
  if (!showBuiltIn && !showLabels) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showBuiltIn && (
        <Select
          value={builtIn ? "built_in" : "all"}
          onValueChange={(value) => {
            const params = new URLSearchParams(searchParams.toString());
            for (const key of [
              "scope",
              "teamIds",
              "authorIds",
              "excludeAuthorIds",
              "page",
            ])
              params.delete(key);
            if (value === "built_in") params.set("scope", value);
            const destination = `${pathname}?${params.toString()}`;
            if (navigate) navigate(destination);
            else router.push(destination, { scroll: false });
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="Filter by origin"
            className={filterControlClass({ active: builtIn })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All origins</SelectItem>
            <SelectItem value="built_in" icon={<Braces className="size-4" />}>
              Built-in
            </SelectItem>
          </SelectContent>
        </Select>
      )}
      {showLabels && <AgentLabelFilter />}
    </div>
  );
}

interface ScopeFilterParams<Scope extends string> {
  scope: Scope | undefined;
  teamIds: undefined;
  authorIds: undefined;
  excludeAuthorIds: undefined;
  excludeOtherPersonal: undefined;
  hasActiveScopeFilters: boolean;
}

/** Ignore retired visibility parameters in bookmarked links. */
export function useScopeFilterParams(options: {
  includeBuiltIn: true;
}): ScopeFilterParams<ScopeValue>;
export function useScopeFilterParams(): ScopeFilterParams<SharedScopeValue>;
export function useScopeFilterParams(options?: {
  includeBuiltIn?: boolean;
}): ScopeFilterParams<ScopeValue> {
  const searchParams = useSearchParams();
  const scope =
    options?.includeBuiltIn && searchParams.get("scope") === "built_in"
      ? "built_in"
      : undefined;
  return {
    scope,
    teamIds: undefined,
    authorIds: undefined,
    excludeAuthorIds: undefined,
    excludeOtherPersonal: undefined,
    hasActiveScopeFilters: !!scope,
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

export function ActiveFilterBadges() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const labelsParam = searchParams.get("labels");
  const parsedLabels = useMemo(
    () => parseLabelsParam(labelsParam),
    [labelsParam],
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

  return <LabelFilterBadges onRemoveLabel={handleRemoveLabel} />;
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
