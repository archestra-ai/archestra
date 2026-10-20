"use client";

import {
  type Permissions,
  RESOURCE_ACCESS_RELATIONS,
  type ResourceAccessRelation,
  type ScopedResource,
} from "@archestra/shared";
import { Check, ChevronDown, Users } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { filterControlClass } from "@/components/filter-bar";
import {
  OWNER_PARAM,
  RESOURCE_ACCESS_PARAM,
  resolveResourceAccess,
  SHARED_WITH_PARAM,
  serializeAccess,
} from "@/components/resource-access-params";
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
 *    Shown only while "Admin access" is on, the one view where the viewer
 *    browses objects shared with other people.
 * 3. "Owner": objects authored by a picked person.
 *
 * The selection lives in the `access`, `sharedWith` and `owner` URL
 * parameters; read it with {@link useResourceAccessParam}.
 */
export function ResourceAccessFilter({
  resource,
  noun,
  owned = true,
  offerAdminAccess = true,
  navigate,
  queryParamsAdapter,
}: {
  /** The grant resource the list shows, for admin visibility and recipient search. */
  resource: ScopedResource;
  /** Plural, lower-case name of the listed objects, e.g. "agents". */
  noun: string;
  /**
   * Off for objects nobody authors (synced models): no "Mine" option and no
   * Owner box, since neither could match anything.
   */
  owned?: boolean;
  /**
   * Off where other people's objects do not belong (Personal Settings): no
   * "Admin access" option, and so no "Shared with" or "Owner" box.
   */
  offerAdminAccess?: boolean;
  /** Override navigation for lists that own local URL state without an RSC round trip. */
  navigate?: (url: string) => void;
  /** Optional logical-to-URL adapter shared by a page section. */
  queryParamsAdapter?: QueryParamsAdapter;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { access, sharedWith, owner, isDefault } = useResourceAccessParam({
    queryParamsAdapter,
    offerAdminAccess,
  });

  const updateParams = useCallback(
    (updates: Record<string, string | null>) => {
      // The lists fetch on the client, so the URL changes in place: a
      // router navigation would re-render the server page on every click.
      if (queryParamsAdapter) {
        queryParamsAdapter.updateQueryParams(
          { ...updates, page: null },
          { shallow: true },
        );
        return;
      }
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      // reset server-side pagination (a no-op on pages without a page param)
      params.delete("page");
      const navigateTo = navigate ?? pushUrlInPlace;
      navigateTo(`${pathname}?${params.toString()}`);
    },
    [searchParams, pathname, navigate, queryParamsAdapter],
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
        owned={owned}
        offerAdminAccess={offerAdminAccess}
        updateParams={updateParams}
        reset={reset}
      />
      {offerAdminAccess && (access.includes("others") || sharedWith) && (
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
      )}
      {offerAdminAccess && owned && (access.includes("others") || owner) && (
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
      )}
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
  /** False drops "Admin access" and its boxes, even from a bookmarked URL. */
  offerAdminAccess?: boolean;
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
  const offerAdminAccess = options?.offerAdminAccess ?? true;
  return useMemo(
    () =>
      resolveResourceAccess({
        rawAccess,
        rawSharedWith,
        rawOwner,
        offerAdminAccess,
      }),
    [rawAccess, rawSharedWith, rawOwner, offerAdminAccess],
  );
}

/** Every URL parameter the access filters own, for a page's "Clear" action. */
export const RESOURCE_ACCESS_FILTER_PARAMS = [
  "access",
  "sharedWith",
  "owner",
] as const;

// ===

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
  owned,
  offerAdminAccess,
  updateParams,
  reset,
}: {
  resource: ScopedResource;
  noun: string;
  access: ResourceAccessRelation[];
  owned: boolean;
  offerAdminAccess: boolean;
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
    (id) =>
      (id !== "others" ||
        (offerAdminAccess && (readsEveryObject || isOn("others")))) &&
      (id !== "mine" || owned),
  );
  const onCount = options.filter(isOn).length;

  const toggle = (id: AccessOptionId) => {
    const turnOn = !isOn(id);
    const toggled = new Set(ACCESS_OPTIONS[id].relations);
    const next = RESOURCE_ACCESS_RELATIONS.filter((relation) =>
      toggled.has(relation) ? turnOn : selected.has(relation),
    );
    // An empty selection would list nothing; keep the last option on.
    if (next.length === 0) return;
    updateParams({
      [RESOURCE_ACCESS_PARAM]: serializeAccess(next),
      // "Shared with" and "Owner" are shown only with "Admin access"; never
      // leave them filtering the list while hidden.
      ...(!next.includes("others") && {
        [SHARED_WITH_PARAM]: null,
        [OWNER_PARAM]: null,
      }),
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Filter by access"
          className={filterControlClass({
            active: serializeAccess(access) !== null,
            className: "shrink-0 whitespace-nowrap max-w-none",
          })}
        >
          <Users className="size-4" />
          <span>{summarize({ access, noun, owned })}</span>
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

/** Change the URL without re-rendering the server page; Next.js syncs `useSearchParams`. */
function pushUrlInPlace(url: string) {
  window.history.pushState(null, "", url);
}

function summarize({
  access,
  noun,
  owned,
}: {
  access: ResourceAccessRelation[];
  noun: string;
  owned: boolean;
}): string {
  if (access.length === RESOURCE_ACCESS_RELATIONS.length) return `All ${noun}`;
  const selected = new Set(access);
  return ACCESS_OPTION_IDS.filter(
    (id) =>
      (id !== "mine" || owned) &&
      ACCESS_OPTIONS[id].relations.some((relation) => selected.has(relation)),
  )
    .map((id) => ACCESS_OPTIONS[id].label)
    .join(" · ");
}
