"use client";

import {
  DEFAULT_RESOURCE_ACCESS_RELATIONS,
  RESOURCE_ACCESS_RELATIONS,
  type ResourceAccessRelation,
  ResourceAccessRelationSchema,
} from "@archestra/shared";
import { ChevronDown, Eye } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { filterControlClass } from "@/components/filter-bar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { QueryParamsAdapter } from "@/lib/hooks/use-query-params-adapter";

/**
 * The "Show" filter of a grant-governed list: which objects to list by how the
 * viewer reaches them. Mine, shared with me or my teams, and shared with the
 * organization are on by default. "Others" is off, so an administrator does
 * not see everyone's personal objects until they ask to. The selection lives
 * in the `access` URL parameter; read it with {@link useResourceAccessParam}.
 */
export function ResourceAccessFilter({
  navigate,
  queryParamsAdapter,
}: {
  /** Override navigation for lists that own local URL state without an RSC round trip. */
  navigate?: (url: string) => void;
  /** Optional logical-to-URL adapter shared by a page section. */
  queryParamsAdapter?: QueryParamsAdapter;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { access, isDefault } = useResourceAccessParam({ queryParamsAdapter });
  const selected = useMemo(() => new Set(access), [access]);

  const setAccess = useCallback(
    (next: ResourceAccessRelation[]) => {
      const value = serializeAccess(next);
      if (queryParamsAdapter) {
        queryParamsAdapter.updateQueryParams({
          [RESOURCE_ACCESS_PARAM]: value,
          page: null,
        });
        return;
      }
      const params = new URLSearchParams(searchParams.toString());
      if (value === null) params.delete(RESOURCE_ACCESS_PARAM);
      else params.set(RESOURCE_ACCESS_PARAM, value);
      // reset server-side pagination (a no-op on pages without a page param)
      params.delete("page");
      const navigateTo =
        navigate ?? ((url: string) => router.push(url, { scroll: false }));
      navigateTo(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname, navigate, queryParamsAdapter],
  );

  const toggle = (relation: ResourceAccessRelation, checked: boolean) => {
    const next = RESOURCE_ACCESS_RELATIONS.filter((candidate) =>
      candidate === relation ? checked : selected.has(candidate),
    );
    // An empty selection would list nothing; keep the last box ticked.
    if (next.length > 0) setAccess(next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Filter by access"
          className={filterControlClass({ active: !isDefault })}
        >
          <Eye className="size-4" />
          <span className="truncate">{summarize(access)}</span>
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Show
        </DropdownMenuLabel>
        {RESOURCE_ACCESS_RELATIONS.map((relation) => (
          <DropdownMenuCheckboxItem
            key={relation}
            checked={selected.has(relation)}
            disabled={selected.size === 1 && selected.has(relation)}
            // Keep the menu open so several boxes can be ticked in one go.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => toggle(relation, checked === true)}
          >
            <div className="flex flex-col">
              <span>{RELATION_COPY[relation].label}</span>
              <span className="text-muted-foreground text-xs">
                {RELATION_COPY[relation].description}
              </span>
            </div>
          </DropdownMenuCheckboxItem>
        ))}
        {!isDefault && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setAccess(DEFAULT_RESOURCE_ACCESS_RELATIONS)}
            >
              Reset to default
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The list's "Show" selection, to pass to its API hook as `access`. A missing
 * or unreadable parameter is the default selection.
 */
export function useResourceAccessParam(options?: {
  queryParamsAdapter?: QueryParamsAdapter;
}): { access: ResourceAccessRelation[]; isDefault: boolean } {
  const searchParams = useSearchParams();
  const raw = (options?.queryParamsAdapter?.searchParams ?? searchParams).get(
    RESOURCE_ACCESS_PARAM,
  );
  return useMemo(() => {
    const access = parseAccess(raw);
    return { access, isDefault: serializeAccess(access) === null };
  }, [raw]);
}

// ===

/** The URL parameter every grant-governed list keeps the "Show" filter in. */
const RESOURCE_ACCESS_PARAM = "access";

const RELATION_COPY: Record<
  ResourceAccessRelation,
  { label: string; short: string; description: string }
> = {
  mine: { label: "Mine", short: "Mine", description: "Created by you" },
  shared: {
    label: "Shared with me",
    short: "Shared",
    description: "Shared with you or one of your teams",
  },
  org: {
    label: "Shared with organization",
    short: "Org",
    description: "Available to everyone in the organization",
  },
  others: {
    label: "Others",
    short: "Others",
    description: "Not shared with you. Visible through your admin access",
  },
};

function parseAccess(raw: string | null): ResourceAccessRelation[] {
  if (!raw) return DEFAULT_RESOURCE_ACCESS_RELATIONS;
  const requested = new Set(
    raw.split(",").flatMap((value) => {
      const parsed = ResourceAccessRelationSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }),
  );
  const access = RESOURCE_ACCESS_RELATIONS.filter((relation) =>
    requested.has(relation),
  );
  return access.length > 0 ? access : DEFAULT_RESOURCE_ACCESS_RELATIONS;
}

/** Null for the default selection, so the default keeps a clean URL. */
function serializeAccess(access: ResourceAccessRelation[]): string | null {
  const value = RESOURCE_ACCESS_RELATIONS.filter((relation) =>
    access.includes(relation),
  ).join(",");
  return value === DEFAULT_RESOURCE_ACCESS_RELATIONS.join(",") ? null : value;
}

function summarize(access: ResourceAccessRelation[]): string {
  if (access.length === RESOURCE_ACCESS_RELATIONS.length) return "All";
  return access.map((relation) => RELATION_COPY[relation].short).join(", ");
}
