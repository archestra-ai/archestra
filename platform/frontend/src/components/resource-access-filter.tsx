"use client";

import {
  DEFAULT_RESOURCE_ACCESS_RELATIONS,
  type Permissions,
  RESOURCE_ACCESS_RELATIONS,
  type ResourceAccessRelation,
  ResourceAccessRelationSchema,
  type ScopedResource,
} from "@archestra/shared";
import { Check, ChevronDown, Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { filterControlClass } from "@/components/filter-bar";
import {
  ResourceOwnerFilter,
  ResourceSharedWithFilter,
} from "@/components/resource-access-subject-filters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import type { QueryParamsAdapter } from "@/lib/hooks/use-query-params-adapter";
import { cn } from "@/lib/utils/tailwind";

/**
 * The access filters of a grant-governed list, as three boxes:
 *
 * 1. Access: how the viewer reaches an object, labelled with the picked
 *    options ("Mine · Shared with me"). Mine and Shared
 *    with me are on by default. "Admin access" (objects nobody shared with the
 *    viewer) is off, and offered only to a viewer who reads every object of
 *    the type through a `*` grant, because nobody else can see such objects.
 * 2. "Shared with": objects whose own grants reach a picked recipient.
 * 3. "Owner": objects authored by a picked person.
 *
 * The selection lives in the `access`, `sharedWith` and `owner` URL
 * parameters (plus `builtIn` on Agents); read it with
 * {@link useResourceAccessParam}.
 */
export function ResourceAccessFilter({
  resource,
  noun,
  offerBuiltIn = false,
  navigate,
  queryParamsAdapter,
}: {
  /** The grant resource the list shows, for admin visibility and recipient search. */
  resource: ScopedResource;
  /** Plural, lower-case name of the listed objects, e.g. "agents". */
  noun: string;
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
  const {
    access,
    sharedWith,
    owner,
    isDefault: isDefaultFilters,
  } = useResourceAccessParam({ queryParamsAdapter });
  const activeSearchParams = queryParamsAdapter?.searchParams ?? searchParams;
  const builtIn =
    offerBuiltIn && activeSearchParams.get(BUILT_IN_PARAM) === "true";
  const isDefault = isDefaultFilters && !builtIn;

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

  const reset = isDefault ? null : (
    <div className="flex justify-end">
      <Button
        variant="ghost"
        size="xs"
        onClick={() =>
          updateParams({
            [RESOURCE_ACCESS_PARAM]: null,
            [SHARED_WITH_PARAM]: null,
            [OWNER_PARAM]: null,
            ...(offerBuiltIn && { [BUILT_IN_PARAM]: null }),
          })
        }
      >
        Reset
      </Button>
    </div>
  );

  return (
    <>
      <AccessRelationFilter
        resource={resource}
        noun={noun}
        access={access}
        builtIn={builtIn}
        offerBuiltIn={offerBuiltIn}
        updateParams={updateParams}
        reset={reset}
      />
      <ResourceSharedWithFilter
        resource={resource}
        value={sharedWith ?? []}
        onChange={(next) =>
          updateParams({
            [SHARED_WITH_PARAM]: next.length > 0 ? next.join(",") : null,
          })
        }
        footer={reset}
      />
      <ResourceOwnerFilter
        resource={resource}
        value={owner ?? []}
        onChange={(next) =>
          updateParams({
            [OWNER_PARAM]: next.length > 0 ? next.join(",") : null,
          })
        }
        footer={reset}
      />
    </>
  );
}

/**
 * The list's access filters, to pass to its API hook as `access`,
 * `sharedWith` and `owner`. A missing or unreadable `access` is the default
 * selection; a missing `sharedWith` or `owner` is undefined (no filtering).
 */
export function useResourceAccessParam(options?: {
  queryParamsAdapter?: QueryParamsAdapter;
}): {
  access: ResourceAccessRelation[];
  sharedWith: string[] | undefined;
  owner: string[] | undefined;
  isDefault: boolean;
} {
  const searchParams = useSearchParams();
  const active = options?.queryParamsAdapter?.searchParams ?? searchParams;
  const rawAccess = active.get(RESOURCE_ACCESS_PARAM);
  const rawSharedWith = active.get(SHARED_WITH_PARAM);
  const rawOwner = active.get(OWNER_PARAM);
  return useMemo(() => {
    const access = parseAccess(rawAccess);
    const sharedWith = parseList(rawSharedWith);
    const owner = parseList(rawOwner);
    return {
      access,
      sharedWith,
      owner,
      isDefault: serializeAccess(access) === null && !sharedWith && !owner,
    };
  }, [rawAccess, rawSharedWith, rawOwner]);
}

/**
 * Every URL parameter the access filters own, for a page's "Clear" action.
 * The Agents-only `builtIn` parameter is included; deleting it elsewhere is
 * a no-op.
 */
export const RESOURCE_ACCESS_FILTER_PARAMS = [
  "access",
  "sharedWith",
  "owner",
  "builtIn",
] as const;

// ===

/** The URL parameter every grant-governed list keeps the relation filter in. */
const RESOURCE_ACCESS_PARAM = "access";
/** The URL parameter of the "Shared with" filter: subject keys. */
const SHARED_WITH_PARAM = "sharedWith";
/** The URL parameter of the "Owner" filter: user ids. */
const OWNER_PARAM = "owner";
/** The URL parameter the Agents page keeps the "Built-in" option in. */
const BUILT_IN_PARAM = "builtIn";

/** The checkbox rows of the first box, each covering one or more relations. */
type AccessOptionId = "mine" | "shared" | "others";

const ACCESS_OPTIONS: Record<
  AccessOptionId,
  { label: string; note: string; relations: ResourceAccessRelation[] }
> = {
  mine: { label: "Mine", note: "you are the owner", relations: ["mine"] },
  shared: {
    label: "Shared with me",
    note: "with you, your team, your role or everyone",
    relations: ["shared", "org"],
  },
  others: {
    label: "Admin access",
    note: "not shared with you",
    relations: ["others"],
  },
};

const ACCESS_OPTION_IDS: AccessOptionId[] = ["mine", "shared", "others"];

function AccessRelationFilter({
  resource,
  noun,
  access,
  builtIn,
  offerBuiltIn,
  updateParams,
  reset,
}: {
  resource: ScopedResource;
  noun: string;
  access: ResourceAccessRelation[];
  builtIn: boolean;
  offerBuiltIn: boolean;
  updateParams: (updates: Record<string, string | null>) => void;
  reset: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const selected = new Set(access);
  const { data: readsEveryObject } = useHasPermissions(
    { [resource]: ["read"] } as Permissions,
    "*",
  );
  const isOn = (id: AccessOptionId) =>
    ACCESS_OPTIONS[id].relations.some((relation) => selected.has(relation));
  // A bookmarked selection that holds "others" keeps the option visible, so
  // the viewer can still clear it.
  const options = ACCESS_OPTION_IDS.filter(
    (id) => id !== "others" || readsEveryObject || isOn("others"),
  );
  const onCount = options.filter(isOn).length;
  // Only agent admins can list the built-in agents.
  const showBuiltIn = offerBuiltIn && (!!readsEveryObject || builtIn);

  const toggle = (id: AccessOptionId) => {
    const turnOn = !isOn(id);
    const toggled = new Set(ACCESS_OPTIONS[id].relations);
    const next = RESOURCE_ACCESS_RELATIONS.filter((relation) =>
      toggled.has(relation) ? turnOn : selected.has(relation),
    );
    // An empty selection would list nothing; keep the last option on.
    if (next.length > 0)
      updateParams({ [RESOURCE_ACCESS_PARAM]: serializeAccess(next) });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Filter by access"
          className={filterControlClass({
            active: serializeAccess(access) !== null || builtIn,
            className: "shrink-0 whitespace-nowrap max-w-none",
          })}
        >
          <Users className="size-4" />
          <span>{summarize({ access, noun })}</span>
          {builtIn && <span>+ Built-in</span>}
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))] p-1"
      >
        {options.map((id) => {
          const on = isOn(id);
          return (
            <CheckboxRow
              key={id}
              label={ACCESS_OPTIONS[id].label}
              note={ACCESS_OPTIONS[id].note}
              badge={id === "others" ? "Admin" : undefined}
              on={on}
              locked={on && onCount === 1}
              onToggle={() => toggle(id)}
            />
          );
        })}
        {showBuiltIn && (
          <BuiltInRow
            on={builtIn}
            onToggle={() =>
              updateParams({ [BUILT_IN_PARAM]: builtIn ? null : "true" })
            }
          />
        )}
        {options.includes("others") && (
          <p className="px-2 pt-1.5 pb-1 text-xs leading-snug text-muted-foreground">
            Admin access: {noun} nobody shared with you. You see them only
            because you have the Admin role.
          </p>
        )}
        {reset && <div className="border-t px-1 pt-1">{reset}</div>}
      </PopoverContent>
    </Popover>
  );
}

/** Agents page only; a component of its own so other pages skip the app-name lookup. */
function BuiltInRow({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const appName = useAppName();
  return (
    <CheckboxRow
      label="Built-in"
      note={`system agents that ${appName} runs for you`}
      on={on}
      locked={false}
      onToggle={onToggle}
    />
  );
}

function CheckboxRow({
  label,
  note,
  badge,
  on,
  locked,
  onToggle,
}: {
  label: string;
  note: string;
  badge?: string;
  on: boolean;
  locked: boolean;
  onToggle: () => void;
}) {
  return (
    <UnstyledButton
      role="checkbox"
      aria-checked={on}
      aria-disabled={locked}
      onClick={locked ? undefined : onToggle}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
        locked && "cursor-default",
      )}
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm border",
          on && "border-primary bg-primary text-primary-foreground",
        )}
      >
        {on && <Check className="size-3" />}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="shrink-0 font-medium">{label}</span>
        {badge && (
          <Badge
            variant="outline"
            className="h-4 shrink-0 self-center px-1 text-[10px] font-normal"
          >
            {badge}
          </Badge>
        )}
        <span className="truncate text-xs text-muted-foreground">{note}</span>
      </span>
    </UnstyledButton>
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

/** A comma-separated list parameter; undefined when absent or empty. */
function parseList(raw: string | null): string[] | undefined {
  const values = [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  return values.length > 0 ? values : undefined;
}

function summarize({
  access,
  noun,
}: {
  access: ResourceAccessRelation[];
  noun: string;
}): string {
  if (access.length === RESOURCE_ACCESS_RELATIONS.length) return `All ${noun}`;
  const selected = new Set(access);
  return ACCESS_OPTION_IDS.filter((id) =>
    ACCESS_OPTIONS[id].relations.some((relation) => selected.has(relation)),
  )
    .map((id) => ACCESS_OPTIONS[id].label)
    .join(" · ");
}
