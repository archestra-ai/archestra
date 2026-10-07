"use client";

import type { Permissions, ResourceAccessRelation } from "@archestra/shared";
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
import { useResourceAccessParam } from "@/components/resource-access-filter";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLabelKeys, useLabelValues } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { QueryParamsAdapter } from "@/lib/hooks/use-query-params-adapter";

type StatusValue = "active" | "deleted";
type SharedScopeValue = "personal" | "team" | "org";
type ScopeValue = SharedScopeValue | "built_in";

/** The agent-label filter of the agent-family pages. */
export function ResourceScopeFilter({
  showLabels = false,
  queryParamsAdapter,
}: {
  /** Render the agent-label filter (agent-family pages only). */
  showLabels?: boolean;
  /** Optional logical-to-URL adapter shared by a page section. */
  queryParamsAdapter?: QueryParamsAdapter;
}) {
  if (!showLabels) return null;
  return <AgentLabelFilter queryParamsAdapter={queryParamsAdapter} />;
}

interface ScopeFilterParams<Scope extends string> {
  scope: Scope | undefined;
  teamIds: undefined;
  authorIds: undefined;
  excludeAuthorIds: undefined;
  excludeOtherPersonal: undefined;
  /** The `ResourceAccessFilter` selection, for the list API's `access`. */
  access: ResourceAccessRelation[];
  hasActiveScopeFilters: boolean;
}

/**
 * Ignore retired visibility parameters in bookmarked links. The access
 * selection replaces them; a non-default one counts as an active filter.
 */
export function useScopeFilterParams(options: {
  includeBuiltIn: true;
  queryParamsAdapter?: QueryParamsAdapter;
}): ScopeFilterParams<ScopeValue>;
export function useScopeFilterParams(options?: {
  includeBuiltIn?: false;
  queryParamsAdapter?: QueryParamsAdapter;
}): ScopeFilterParams<SharedScopeValue>;
export function useScopeFilterParams(options?: {
  includeBuiltIn?: boolean;
  queryParamsAdapter?: QueryParamsAdapter;
}): ScopeFilterParams<ScopeValue> {
  const searchParams = useSearchParams();
  const activeSearchParams =
    options?.queryParamsAdapter?.searchParams ?? searchParams;
  const { access, isDefault: isDefaultAccess } = useResourceAccessParam({
    queryParamsAdapter: options?.queryParamsAdapter,
  });
  const scope =
    options?.includeBuiltIn && activeSearchParams.get("scope") === "built_in"
      ? "built_in"
      : undefined;
  return {
    scope,
    teamIds: undefined,
    authorIds: undefined,
    excludeAuthorIds: undefined,
    excludeOtherPersonal: undefined,
    access,
    hasActiveScopeFilters: !!scope || !isDefaultAccess,
  };
}

export function ResourceDeletedStatusFilter({
  deletePermission,
  deletePermissionScope,
  queryParamsAdapter,
}: {
  deletePermission: Permissions;
  /** Checks `deletePermission` as a grant at this scope (e.g. `*`). */
  deletePermissionScope?: string;
  queryParamsAdapter?: QueryParamsAdapter;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { data: canDelete } = useHasPermissions(
    deletePermission,
    deletePermissionScope,
  );

  const activeSearchParams = queryParamsAdapter?.searchParams ?? searchParams;
  const status =
    (activeSearchParams.get("status") as StatusValue | null) ?? "active";

  const handleStatusChange = useCallback(
    (value: string) => {
      if (queryParamsAdapter) {
        queryParamsAdapter.updateQueryParams({
          status: value === "deleted" ? "deleted" : null,
          page: null,
        });
        return;
      }
      const params = new URLSearchParams(searchParams.toString());
      if (value === "deleted") {
        params.set("status", "deleted");
      } else {
        params.delete("status");
      }
      params.delete("page");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname, queryParamsAdapter],
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
  queryParamsAdapter,
  showLabels = true,
}: {
  /** Optional logical-to-URL adapter shared by a page section. */
  queryParamsAdapter?: QueryParamsAdapter;
  /** Whether to read and render badges for the agent-only labels query param. */
  showLabels?: boolean;
} = {}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const activeSearchParams = queryParamsAdapter?.searchParams ?? searchParams;
  const labelsParam = showLabels ? activeSearchParams.get("labels") : null;
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
      if (queryParamsAdapter) {
        queryParamsAdapter.updateQueryParams({
          labels: serializeLabels(updated) || null,
          page: null,
        });
        return;
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
    [parsedLabels, searchParams, router, pathname, queryParamsAdapter],
  );

  return <LabelFilterBadges onRemoveLabel={handleRemoveLabel} />;
}

// The label filter is agent-specific (labels only exist on agents); keeping it
// in a child component keeps its queries out of pages that don't render it.
function AgentLabelFilter({
  queryParamsAdapter,
}: {
  queryParamsAdapter?: QueryParamsAdapter;
}) {
  const { data: labelKeys } = useLabelKeys();
  const searchParams = useSearchParams();
  const labelsParam = (queryParamsAdapter?.searchParams ?? searchParams).get(
    "labels",
  );
  const hasLabels = Object.keys(parseLabelsParam(labelsParam) ?? {}).length > 0;
  return (
    <LabelSelect
      labelKeys={labelKeys}
      LabelKeyRowComponent={AgentLabelKeyRow}
      className={filterControlClass({ active: hasLabels })}
      queryParamsAdapter={queryParamsAdapter}
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
