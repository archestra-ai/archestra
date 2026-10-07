"use client";

import {
  DEFAULT_RESOURCE_ACCESS_RELATIONS,
  type Permissions,
  RESOURCE_ACCESS_RELATIONS,
  type ResourceAccessRelation,
  ResourceAccessRelationSchema,
  type ScopedResource,
} from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import {
  Braces,
  Building2,
  Check,
  ChevronDown,
  Lock,
  type LucideIcon,
  User,
  Users,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { filterControlClass } from "@/components/filter-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { QueryParamsAdapter } from "@/lib/hooks/use-query-params-adapter";
import { cn } from "@/lib/utils/tailwind";

/** What a list's count function receives for one option of the filter. */
export interface ResourceAccessCountParams {
  access: ResourceAccessRelation[];
  /** Agents page only: also count the built-in agents. */
  includeBuiltIn?: boolean;
}

/**
 * The "Show" filter of a grant-governed list: which objects to list by how the
 * viewer reaches them. Each option is a card with a description and a live
 * count. Mine, shared with me or my teams, and shared with the organization
 * are on by default. "Not shared with me" is off, so an administrator does not
 * see everyone's personal objects until they ask to. It is offered only to a
 * viewer who reads every object of the type through a `*` grant, because
 * nobody else can see an object outside the other three. The selection lives
 * in the `access` URL parameter; read it with {@link useResourceAccessParam}.
 */
export function ResourceAccessFilter({
  resource,
  noun,
  countItems,
  countKey,
  offerBuiltIn = false,
  navigate,
  queryParamsAdapter,
}: {
  /** The grant resource the list shows, which decides whether "Not shared with me" applies. */
  resource: ScopedResource;
  /** Plural, lower-case name of the listed objects, e.g. "agents". */
  noun: string;
  /** How many objects the list holds for a selection, ignoring its other filters. */
  countItems: (params: ResourceAccessCountParams) => Promise<number>;
  /** Extra values `countItems` depends on, so the counts refetch when they change. */
  countKey?: readonly unknown[];
  /** Agents page only: offer the "Built-in" option, kept in the `builtIn` URL parameter. */
  offerBuiltIn?: boolean;
  /** Override navigation for lists that own local URL state without an RSC round trip. */
  navigate?: (url: string) => void;
  /** Optional logical-to-URL adapter shared by a page section. */
  queryParamsAdapter?: QueryParamsAdapter;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { access, isDefault: isDefaultAccess } = useResourceAccessParam({
    queryParamsAdapter,
  });
  const activeSearchParams = queryParamsAdapter?.searchParams ?? searchParams;
  const builtIn =
    offerBuiltIn && activeSearchParams.get(BUILT_IN_PARAM) === "true";
  const isDefault = isDefaultAccess && !builtIn;
  const selected = useMemo(() => new Set(access), [access]);
  const { data: readsEveryObject } = useHasPermissions(
    { [resource]: ["read"] } as Permissions,
    "*",
  );
  // A bookmarked selection that holds "others" keeps the option visible, so
  // the viewer can still clear it.
  const relations = RESOURCE_ACCESS_RELATIONS.filter(
    (relation) =>
      relation !== "others" || readsEveryObject || selected.has("others"),
  );
  // Only agent admins can list the built-in agents.
  const showBuiltIn = offerBuiltIn && (!!readsEveryObject || builtIn);

  const updateParams = useCallback(
    (updates: Record<string, string | null>) => {
      if (queryParamsAdapter) {
        queryParamsAdapter.updateQueryParams({ ...updates, page: null });
        return;
      }
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) params.delete(key);
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

  const toggle = (relation: ResourceAccessRelation) => {
    const next = RESOURCE_ACCESS_RELATIONS.filter((candidate) =>
      candidate === relation
        ? !selected.has(candidate)
        : selected.has(candidate),
    );
    // An empty selection would list nothing; keep the last option on.
    if (next.length > 0)
      updateParams({ [RESOURCE_ACCESS_PARAM]: serializeAccess(next) });
  };

  const count = useCallback(
    (params: ResourceAccessCountParams) => ({
      queryKey: [
        "resource-access-count",
        resource,
        noun,
        ...(countKey ?? []),
        params.access,
        params.includeBuiltIn ?? false,
      ],
      queryFn: () => countItems(params),
      enabled: open,
    }),
    [resource, noun, countKey, countItems, open],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Filter by access"
          className={filterControlClass({ active: !isDefault })}
        >
          <Users className="size-4" />
          <span className="truncate">{summarize({ access, noun })}</span>
          {builtIn && <span className="shrink-0">+ Built-in</span>}
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(24rem,calc(100vw-2rem))] p-2"
      >
        <div className="grid gap-1.5">
          {relations.map((relation) => (
            <AccessOption
              key={relation}
              relation={relation}
              noun={noun}
              on={selected.has(relation)}
              locked={selected.size === 1 && selected.has(relation)}
              count={count({ access: [relation] })}
              onToggle={() => toggle(relation)}
            />
          ))}
        </div>
        {showBuiltIn && (
          <BuiltInOption
            on={builtIn}
            count={count({
              access: [...RESOURCE_ACCESS_RELATIONS],
              includeBuiltIn: true,
            })}
            listedWithout={count({ access: [...RESOURCE_ACCESS_RELATIONS] })}
            onToggle={() =>
              updateParams({ [BUILT_IN_PARAM]: builtIn ? null : "true" })
            }
          />
        )}
        <div className="mt-2 flex items-center justify-between gap-2 px-1">
          <SelectionCount
            noun={noun}
            shown={count({ access, includeBuiltIn: builtIn || undefined })}
            all={count({
              access: [...RESOURCE_ACCESS_RELATIONS],
              includeBuiltIn: showBuiltIn || undefined,
            })}
          />
          {!isDefault && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() =>
                updateParams({
                  [RESOURCE_ACCESS_PARAM]: null,
                  ...(offerBuiltIn && { [BUILT_IN_PARAM]: null }),
                })
              }
            >
              Reset
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
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
/** The URL parameter the Agents page keeps the "Built-in" option in. */
const BUILT_IN_PARAM = "builtIn";

type CountQuery = {
  queryKey: unknown[];
  queryFn: () => Promise<number>;
  enabled: boolean;
};

const RELATION_COPY: Record<
  ResourceAccessRelation,
  {
    label: string;
    short: string;
    describe: (noun: string) => string;
    icon: LucideIcon;
  }
> = {
  mine: {
    label: "Mine",
    short: "Mine",
    describe: (noun) => `${capitalize(noun)} you created.`,
    icon: User,
  },
  shared: {
    label: "Shared with me",
    short: "Shared with me",
    describe: () => "Someone shared them with you or with a team you are in.",
    icon: Users,
  },
  org: {
    label: "Whole organization",
    short: "Organization",
    describe: () => "Shared with everyone in the organization.",
    icon: Building2,
  },
  others: {
    label: "Not shared with me",
    short: "Not shared with me",
    describe: (noun) =>
      `Other people's ${noun} that nobody shared with you. You see them only because you are an admin.`,
    icon: Lock,
  },
};

function AccessOption({
  relation,
  noun,
  on,
  locked,
  count,
  onToggle,
}: {
  relation: ResourceAccessRelation;
  noun: string;
  on: boolean;
  locked: boolean;
  count: CountQuery;
  onToggle: () => void;
}) {
  const { label, describe, icon: Icon } = RELATION_COPY[relation];
  const isOthers = relation === "others";
  const { data: total } = useQuery(count);
  return (
    <UnstyledButton
      role="checkbox"
      aria-checked={on}
      aria-disabled={locked}
      onClick={locked ? undefined : onToggle}
      className={cn(
        "relative flex w-full items-start gap-3 rounded-md border p-2.5 text-left transition-colors",
        isOthers && "border-dashed",
        on ? "border-primary/50 bg-primary/10" : "hover:bg-muted/50",
        locked && "cursor-default",
      )}
    >
      <span className="mt-0.5">
        <CheckMark on={on} />
      </span>
      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {label}
          {isOthers && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[10px] font-normal"
            >
              Admin
            </Badge>
          )}
        </span>
        <span className="text-muted-foreground text-xs leading-snug">
          {describe(noun)}
        </span>
      </span>
      <span className="text-lg font-semibold tabular-nums">{total ?? "–"}</span>
    </UnstyledButton>
  );
}

/** Agents page only: a lighter one-line row under the access options. */
function BuiltInOption({
  on,
  count,
  listedWithout,
  onToggle,
}: {
  on: boolean;
  count: CountQuery;
  listedWithout: CountQuery;
  onToggle: () => void;
}) {
  const { data: withBuiltIn } = useQuery(count);
  const { data: without } = useQuery(listedWithout);
  const total =
    withBuiltIn === undefined || without === undefined
      ? undefined
      : withBuiltIn - without;
  return (
    <>
      <div className="text-muted-foreground mt-2 mb-1 px-1 text-[11px] font-medium tracking-wide uppercase">
        Also show
      </div>
      <UnstyledButton
        role="checkbox"
        aria-checked={on}
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left transition-colors",
          on ? "bg-primary/10" : "bg-muted/30 hover:bg-muted/60",
        )}
      >
        <CheckMark on={on} />
        <Braces className="text-muted-foreground size-4 shrink-0" />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium whitespace-nowrap">
            Built-in
          </span>
          <span className="text-muted-foreground truncate text-xs">
            System agents that Archestra runs for you.
          </span>
        </span>
        <span className="text-muted-foreground text-sm font-semibold tabular-nums">
          {total ?? "–"}
        </span>
      </UnstyledButton>
    </>
  );
}

function SelectionCount({
  noun,
  shown,
  all,
}: {
  noun: string;
  shown: CountQuery;
  all: CountQuery;
}) {
  const { data: shownTotal } = useQuery(shown);
  const { data: allTotal } = useQuery(all);
  return (
    <span className="text-muted-foreground text-xs">
      <span className="text-foreground font-medium tabular-nums">
        {shownTotal ?? "–"}
      </span>{" "}
      of <span className="tabular-nums">{allTotal ?? "–"}</span> {noun}
    </span>
  );
}

function CheckMark({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-sm border",
        on && "border-primary bg-primary text-primary-foreground",
      )}
    >
      {on && <Check className="size-3" />}
    </span>
  );
}

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

function summarize({
  access,
  noun,
}: {
  access: ResourceAccessRelation[];
  noun: string;
}): string {
  if (access.length === RESOURCE_ACCESS_RELATIONS.length) return `All ${noun}`;
  if (serializeAccess(access) === null)
    return `${capitalize(noun)} I can access`;
  return access.map((relation) => RELATION_COPY[relation].short).join(" · ");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
