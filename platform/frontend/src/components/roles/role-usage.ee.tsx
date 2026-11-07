// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Search,
  UserRound,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useMembersPaginated } from "@/lib/member.query";
import { useServiceAccounts } from "@/lib/service-account.query";
import { useTeams } from "@/lib/teams/team.query";
import { cn } from "@/lib/utils/tailwind";

type Role = archestraApiTypes.GetRoleResponses["200"];

/**
 * Who holds the role: the teams that pass it to their members, the users it
 * is assigned to directly, and the service accounts that act with it. Three
 * count tiles double as a segmented control over one searchable, paged list,
 * so the section never grows past a page of rows however many holders an
 * organization has. Users come a page at a time from the server, since the
 * default role is held by nearly everyone.
 */
export function RoleUsage({ role }: { role: Role }) {
  const data = useUsageData(role);
  const [picked, setPicked] = useState<Kind | null>(null);
  // Client-side search and paging for the whole-list kinds, kept per kind so
  // switching tiles and coming back lands where the reader left off.
  const [local, setLocal] = useState<LocalState>({
    teams: { query: "", page: 0 },
    accounts: { query: "", page: 0 },
  });
  const baseId = useId();

  // Only the kinds the viewer may list; a role page is readable with far
  // fewer permissions than the people lists behind it.
  const kinds = ORDER.filter((candidate) => data[candidate].readable);
  // Until the reader picks a tile, land on the first kind that has holders,
  // and stay there: a later search that matches nobody must not switch tiles.
  const settled = kinds.every((candidate) => data[candidate].loaded);
  useEffect(() => {
    if (picked !== null || !settled || kinds.length === 0) return;
    setPicked(kinds.find((candidate) => data[candidate].total > 0) ?? kinds[0]);
  }, [picked, settled, kinds, data]);
  const kind: Kind = picked ?? kinds[0] ?? "teams";
  const view = useListView({ data, kind, local });
  const meta = KINDS[kind];

  const moveSelection = (event: React.KeyboardEvent, step: number) => {
    const index = kinds.indexOf(kind);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? kinds.length - 1
          : (index + step + kinds.length) % kinds.length;
    event.preventDefault();
    setPicked(kinds[next]);
    document.getElementById(`${baseId}-tab-${kinds[next]}`)?.focus();
  };

  const setQuery = (query: string) => {
    if (kind === "users") {
      data.users.setQuery(query);
      return;
    }
    setLocal((prev) => ({ ...prev, [kind]: { query, page: 0 } }));
  };
  const setPage = (page: number) => {
    if (kind === "users") {
      data.users.setPage(page);
      return;
    }
    setLocal((prev) => ({ ...prev, [kind]: { ...prev[kind], page } }));
  };

  if (kinds.length === 0) {
    return (
      <p className="rounded-lg border px-3 py-6 text-center text-[13px] text-muted-foreground">
        You don't have permission to see who holds this role.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label="Role holders"
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${kinds.length}, minmax(0, 1fr))`,
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            moveSelection(event, 1);
          } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            moveSelection(event, -1);
          } else if (event.key === "Home" || event.key === "End") {
            moveSelection(event, 0);
          }
        }}
      >
        {kinds.map((candidate) => {
          const { label, icon: Icon } = KINDS[candidate];
          const bucket = data[candidate];
          const selected = candidate === kind;
          return (
            <UnstyledButton
              key={candidate}
              role="tab"
              id={`${baseId}-tab-${candidate}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setPicked(candidate)}
              className={cn(
                "flex min-w-0 flex-col gap-1 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors",
                "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                selected
                  ? "border-foreground/30 bg-muted/50"
                  : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{label}</span>
              </span>
              {!bucket.loaded ? (
                <Skeleton className="h-6 w-10" />
              ) : (
                <span
                  className={cn(
                    "text-lg font-semibold leading-6 tabular-nums",
                    selected ? "text-foreground" : "text-foreground/80",
                  )}
                >
                  {bucket.total}
                </span>
              )}
            </UnstyledButton>
          );
        })}
      </div>

      <section
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${kind}`}
        className="overflow-hidden rounded-lg border bg-card text-[13px]"
      >
        {!view.loaded ? (
          <ListSkeleton />
        ) : view.total === 0 && !view.query && !view.pending ? (
          <p className="px-3 py-6 text-center text-muted-foreground">
            {meta.empty}
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b bg-muted/30 px-2 py-1.5">
              <div className="relative min-w-0 flex-1 sm:max-w-xs">
                <Search
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  aria-label={meta.placeholder}
                  placeholder={meta.placeholder}
                  value={view.query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-7 bg-background pl-7.5 text-[13px]"
                />
              </div>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {view.query && view.unfilteredTotal !== null
                  ? `${view.total} of ${view.unfilteredTotal} ${pluralize(meta.singular, view.unfilteredTotal)}`
                  : `${view.total} ${pluralize(meta.singular, view.total)}`}
              </span>
            </div>

            {view.pending ? (
              <RowsSkeleton />
            ) : view.rows.length === 0 ? (
              <p className="px-3 py-6 text-center text-muted-foreground">
                No {meta.singular} matches &ldquo;{view.query}&rdquo;.
              </p>
            ) : (
              <ul className="divide-y divide-border/60">
                {view.rows.map((row) => (
                  <li key={row.id}>
                    <HolderRow kind={kind} holder={row} />
                  </li>
                ))}
              </ul>
            )}

            {!view.pending && view.pageCount > 1 && (
              <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {view.page * PAGE_SIZE + 1}–
                  {Math.min((view.page + 1) * PAGE_SIZE, view.total)} of{" "}
                  {view.total}
                </span>
                <div className="flex items-center gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Previous page"
                    disabled={view.page === 0}
                    onClick={() => setPage(view.page - 1)}
                  >
                    <ChevronLeft aria-hidden="true" />
                  </Button>
                  <span className="min-w-14 text-center tabular-nums">
                    {view.page + 1} / {view.pageCount}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Next page"
                    disabled={view.page + 1 >= view.pageCount}
                    onClick={() => setPage(view.page + 1)}
                  >
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ===================================================================
// Internal
// ===================================================================

type Kind = "teams" | "users" | "accounts";

/** One holder of the role, whichever kind it is. */
type Holder = {
  id: string;
  name: string;
  /** Secondary line: a team's description, a user's email, "Disabled". */
  detail: string;
  /** Avatar URL for users, when they have one. */
  image?: string | null;
  /** The list page where the holder is found. */
  href: string;
};

type Bucket = {
  items: Holder[];
  total: number;
  /** A request is in flight: the first one, or a new search or page. */
  pending: boolean;
  /** The first request has answered, so the count and list mean something. */
  loaded: boolean;
  /** The viewer may list this kind at all. */
  readable: boolean;
};

type UsageData = {
  /** Every team that passes the role on. The whole list. */
  teams: Bucket;
  /** Users holding the role directly, a server page at a time. */
  users: Bucket & {
    /** Users matching the current query; `total` is the count without it. */
    matching: number;
    page: number;
    pageCount: number;
    setPage: (page: number) => void;
    query: string;
    setQuery: (query: string) => void;
  };
  /** Every service account acting with the role. The whole list. */
  accounts: Bucket;
};

type LocalState = Record<"teams" | "accounts", { query: string; page: number }>;

type ListView = {
  pending: boolean;
  loaded: boolean;
  rows: Holder[];
  /** Holders matching the current query. */
  total: number;
  /** Holders of this kind regardless of query; null when only the server knows. */
  unfilteredTotal: number | null;
  query: string;
  page: number;
  pageCount: number;
};

const PAGE_SIZE = 20;
const ORDER: Kind[] = ["teams", "users", "accounts"];

const KINDS: Record<
  Kind,
  {
    label: string;
    singular: string;
    icon: typeof Users;
    empty: string;
    placeholder: string;
  }
> = {
  teams: {
    label: "Teams",
    singular: "team",
    icon: Users,
    empty: "No team passes this role to its members.",
    placeholder: "Search teams",
  },
  users: {
    label: "Users",
    singular: "user",
    icon: UserRound,
    empty: "No user holds this role directly.",
    placeholder: "Search users by name or email",
  },
  accounts: {
    label: "Service accounts",
    singular: "service account",
    icon: Bot,
    empty: "No service account acts with this role.",
    placeholder: "Search service accounts",
  },
};

function useUsageData(role: Role): UsageData {
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  // Each list has its own read permission; a role page needs none of them.
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: canReadMembers } = useHasPermissions({ member: ["read"] });
  const { data: canReadAccounts } = useHasPermissions({
    serviceAccount: ["read"],
  });
  const { data: teams, isPending: teamsPending } = useTeams({
    includeRelations: false,
    all: true,
    enabled: canReadTeams === true,
  });
  const { data: accounts, isPending: accountsPending } = useServiceAccounts();
  const { data: members, isPending: membersPending } = useMembersPaginated(
    {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      role: role.role,
      name: query || undefined,
    },
    { enabled: canReadMembers === true },
  );
  // Once a list has answered it stays on screen while a search or a page
  // reloads it, so the reader's focus never falls out of the search box.
  const loaded = useRef({ teams: false, users: false, accounts: false });
  if (canReadTeams && !teamsPending) loaded.current.teams = true;
  if (canReadMembers && !membersPending) loaded.current.users = true;
  if (canReadAccounts && !accountsPending) loaded.current.accounts = true;
  // The server only counts users matching the query; the tile shows the
  // count without one, remembered from the last unfiltered answer.
  const allUsers = useRef(0);
  if (!query && members) allUsers.current = members.pagination.total;
  const holdingTeams = (teams ?? [])
    .filter((team) => team.roles?.includes(role.role))
    .map((team) => ({
      id: team.id,
      name: team.name,
      detail: team.description || "",
      href: "/settings/teams",
    }));
  const holdingAccounts = (accounts ?? [])
    .filter((account) => account.role.split(",").includes(role.role))
    .map((account) => ({
      id: account.id,
      name: account.name,
      detail: account.disabled ? "Disabled" : "",
      href: `/settings/service-accounts/${account.id}`,
    }));
  return {
    teams: {
      items: holdingTeams,
      total: holdingTeams.length,
      pending: teamsPending,
      loaded: loaded.current.teams,
      readable: canReadTeams === true,
    },
    users: {
      items: (members?.data ?? []).map((member) => ({
        id: member.id,
        name: member.name || member.email,
        detail: member.name ? member.email : "",
        image: member.image,
        href: `/settings/users?name=${encodeURIComponent(member.email)}`,
      })),
      total: allUsers.current,
      matching: members?.pagination.total ?? 0,
      pending: membersPending,
      loaded: loaded.current.users,
      readable: canReadMembers === true,
      page,
      pageCount: members?.pagination.totalPages ?? 0,
      setPage,
      query,
      setQuery: (next) => {
        setQuery(next);
        setPage(0);
      },
    },
    accounts: {
      items: holdingAccounts,
      total: holdingAccounts.length,
      pending: accountsPending,
      loaded: loaded.current.accounts,
      readable: canReadAccounts === true,
    },
  };
}

/** One page of the selected kind, searched and paged wherever that kind's data lives. */
function useListView({
  data,
  kind,
  local,
}: {
  data: UsageData;
  kind: Kind;
  local: LocalState;
}): ListView {
  return useMemo(() => {
    if (kind === "users") {
      const { users } = data;
      return {
        pending: users.pending,
        loaded: users.loaded,
        rows: users.items,
        total: users.matching,
        unfilteredTotal: users.total,
        query: users.query,
        page: users.page,
        pageCount: users.pageCount,
      };
    }
    const bucket = data[kind];
    const { query, page } = local[kind];
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? bucket.items.filter(
          (holder) =>
            holder.name.toLowerCase().includes(needle) ||
            holder.detail.toLowerCase().includes(needle),
        )
      : bucket.items;
    const pageCount = Math.ceil(matches.length / PAGE_SIZE);
    const safePage = Math.min(page, Math.max(pageCount - 1, 0));
    return {
      pending: bucket.pending,
      loaded: bucket.loaded,
      rows: matches.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
      total: matches.length,
      unfilteredTotal: bucket.total,
      query,
      page: safePage,
      pageCount,
    };
  }, [data, kind, local]);
}

function HolderRow({ kind, holder }: { kind: Kind; holder: Holder }) {
  const disabled = holder.detail === "Disabled";
  const Icon = KINDS[kind].icon;
  return (
    <Link
      href={holder.href}
      className="flex min-h-9 items-center gap-2.5 px-3 py-1.5 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
    >
      {kind === "users" ? (
        <Avatar className="size-6">
          {holder.image && <AvatarImage src={holder.image} alt="" />}
          <AvatarFallback className="text-[10px] font-medium text-muted-foreground">
            {initials(holder.name)}
          </AvatarFallback>
        </Avatar>
      ) : (
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
      )}
      <span className="truncate font-medium">{holder.name}</span>
      {disabled ? (
        <Badge
          variant="outline"
          className="ml-auto shrink-0 text-muted-foreground"
        >
          Disabled
        </Badge>
      ) : holder.detail ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {holder.detail}
        </span>
      ) : null}
    </Link>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" className="space-y-px">
      <div className="border-b bg-muted/30 px-2 py-1.5">
        <Skeleton className="h-7 w-full sm:max-w-xs" />
      </div>
      <RowsSkeleton />
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div aria-busy="true">
      <ul className="divide-y divide-border/60">
        {SKELETON_ROWS.map(([key, name, detail]) => (
          <li
            key={key}
            className="flex min-h-9 items-center gap-2.5 px-3 py-1.5"
          >
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className={cn("h-3.5", name)} />
            <Skeleton className={cn("h-3.5", detail)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const SKELETON_ROWS: [string, string, string][] = [
  ["a", "w-32", "w-52"],
  ["b", "w-40", "w-44"],
  ["c", "w-28", "w-56"],
  ["d", "w-36", "w-40"],
  ["e", "w-30", "w-48"],
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
