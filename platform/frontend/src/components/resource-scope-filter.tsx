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
import type { QueryParamsAdapter } from "@/lib/hooks/use-query-params-adapter";

type StatusValue = "active" | "deleted";
type SharedScopeValue = "personal" | "team" | "org";
type ScopeValue = SharedScopeValue | "built_in";

/** Resource origin and labels are independent of who has permission to access it. */
export function ResourceScopeFilter({
  showBuiltIn = false,
  showLabels = false,
  navigate,
  queryParamsAdapter,
}: {
  /** Offer a "Built-in" origin (agents page only). */
  showBuiltIn?: boolean;
  /** Render the agent-label filter (agent-family pages only). */
  showLabels?: boolean;
  /** Override navigation for lists that own local URL state without an RSC round trip. */
  navigate?: (url: string) => void;
  /** Optional logical-to-URL adapter shared by a page section. */
  queryParamsAdapter?: QueryParamsAdapter;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const activeSearchParams = queryParamsAdapter?.searchParams ?? searchParams;
  const builtIn = showBuiltIn && activeSearchParams.get("scope") === "built_in";
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      if (queryParamsAdapter) {
        queryParamsAdapter.updateQueryParams({ ...updates, page: null });
        return;
      }
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      }
      // reset server-side pagination (a no-op on pages without a page param)
      params.delete("page");
      const navigateTo =
        navigate ?? ((url: string) => router.push(url, { scroll: false }));
      navigateTo(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname, navigate, queryParamsAdapter],
  );
  if (!showBuiltIn && !showLabels) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showBuiltIn && (
        <Select
          value={builtIn ? "built_in" : "all"}
          onValueChange={(value) =>
            updateUrlParams({
              scope: value === "built_in" ? value : null,
              teamIds: null,
              authorIds: null,
              excludeAuthorIds: null,
            })
          }
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
      {showLabels && (
        <AgentLabelFilter queryParamsAdapter={queryParamsAdapter} />
      )}
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
    hasActiveScopeFilters: !!scope,
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
