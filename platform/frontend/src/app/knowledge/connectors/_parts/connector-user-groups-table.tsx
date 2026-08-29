// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Users } from "lucide-react";
import { useMemo, useState } from "react";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { RelativeTime } from "@/components/relative-time";
import { SearchInput } from "@/components/search-input";
import { DataTable } from "@/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  ConnectorUserGroup,
  ConnectorUserGroupMember,
} from "@/lib/knowledge/connector.query";
import { useConnectorUserGroups } from "@/lib/knowledge/connector.query";
import { MembershipTruncationNotice } from "./connector-membership-truncation-notice";
import {
  capitalizeNoun,
  GROUP_ROSTER_NOUN,
  type RosterNoun,
} from "./roster-noun";

type GroupFilter = "all" | "fully-assigned" | "not-fully-assigned";

/**
 * The Groups tab: the synced group snapshot — which upstream groups exist,
 * how many documents each gates, and how healthy member resolution is. Each
 * row keeps a compact membership summary (`assigned/total`, full list on
 * hover); per-user detail and manual mapping live on the Users tab.
 * Severity-first ordering, search, and an attention filter surface the
 * groups an admin must act on without scrolling.
 */
export function ConnectorUserGroupsTable({
  connectorId,
  noun = GROUP_ROSTER_NOUN,
}: {
  connectorId: string;
  noun?: RosterNoun;
}) {
  const {
    data: userGroups,
    isFetching,
    isError,
  } = useConnectorUserGroups({ connectorId, enabled: true });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<GroupFilter>("all");
  const [memberFilter, setMemberFilter] = useState<string>("all");

  const groups = useMemo(() => userGroups?.groups ?? [], [userGroups?.groups]);

  // Distinct people across the snapshot, for the member filter. A resolved
  // member — email-matched or manually assigned alike — is offered as the org
  // user it resolves to, one option per user even when several upstream
  // accounts map to the same person; only unresolved accounts fall back to
  // their upstream identity. Values carry a `user:` / `account:` prefix so a
  // selection knows which side it names (see matchesMemberFilter for the
  // reverse mapping).
  const memberOptions = useMemo(() => {
    const byUser = new Map<string, string>();
    const byAccount = new Map<string, string>();
    for (const group of groups) {
      for (const member of group.members) {
        if (isServiceAccount(member)) continue;
        if (member.user) {
          byUser.set(
            member.user.id,
            `${member.user.name} (${member.user.email})`,
          );
        } else {
          byAccount.set(
            member.accountId,
            member.displayName ?? member.email ?? member.accountId,
          );
        }
      }
    }
    return [
      ...[...byUser.entries()].map(([id, label]) => ({
        value: `user:${id}`,
        label,
      })),
      ...[...byAccount.entries()].map(([id, label]) => ({
        value: `account:${id}`,
        label,
      })),
    ].sort((a, b) => a.label.localeCompare(b.label));
  }, [groups]);

  const visibleGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    return groups
      .filter((group) => matchesFilter(group, filter))
      .filter(
        (group) =>
          memberFilter === "all" ||
          group.members.some((member) =>
            matchesMemberFilter(member, memberFilter),
          ),
      )
      .filter((group) => matchesSearch(group, query))
      .sort(compareGroupsBySeverity);
  }, [groups, search, filter, memberFilter]);

  const columns = useMemo<ColumnDef<ConnectorUserGroup>[]>(
    () => [
      {
        // Own unlabeled column (same as the Users table's avatar): the
        // Group header then aligns with the names, not the icon.
        id: "avatar",
        header: "",
        size: 40,
        cell: () => (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
            <Users className="h-4 w-4 text-muted-foreground" />
          </div>
        ),
      },
      {
        id: "group",
        accessorKey: "groupId",
        header: noun.columnHeader,
        // Group ids run long (e.g. `confluence-user-access-admins-…`); a
        // fixed wide column keeps them readable instead of truncating at
        // the even share.
        size: 320,
        cell: ({ row }) => {
          // A synthetic group id (Notion's `workspace-members-<workspaceId>`)
          // is an Archestra construct: show the id the source itself shows, so
          // this line matches what an admin sees upstream.
          const sourceId =
            noun.sourceId?.(row.original.groupId) ?? row.original.groupId;
          return (
            <div className="min-w-0">
              <div
                className="truncate text-sm font-medium"
                title={row.original.name ?? row.original.groupId}
              >
                {row.original.name ?? row.original.groupId}
              </div>
              <div
                className="truncate text-xs text-muted-foreground"
                title={
                  row.original.name
                    ? `${noun.idLabel}: ${sourceId}`
                    : row.original.token
                }
              >
                {row.original.name ? `ID ${sourceId}` : row.original.token}
              </div>
            </div>
          );
        },
      },
      {
        id: "documentCount",
        accessorKey: "documentCount",
        header: "Documents",
        // Wide enough for the header word itself: the shared table breaks a
        // header that outgrows its column mid-word ("Documen / ts").
        size: 130,
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">
            {row.original.documentCount.toLocaleString()}
          </span>
        ),
      },
      {
        // One membership column, not two. The `assigned/total` verdict is
        // what the tab is read for; the roster behind it is a hover away and
        // in full on the Users tab, which is where a member can be acted on.
        // As two columns the badge list took a third of the table to restate
        // the number beside it.
        id: "members",
        header: "Members",
        size: 260,
        cell: ({ row }) => (
          <GroupMembersSummary group={row.original} noun={noun} />
        ),
      },
      {
        id: "lastSyncedAt",
        accessorKey: "lastSyncedAt",
        header: "Last Synced",
        size: 160,
        cell: ({ row }) => (
          <RelativeTime date={row.original.lastSyncedAt} showIcon />
        ),
      },
    ],
    [noun],
  );

  return (
    <div>
      {groups.length > 0 && (
        <CollectionFilters>
          <FilterBar>
            <SearchInput
              value={search}
              syncQueryParams={false}
              placeholder={`Search by ${noun.singular} or member name`}
              className={filterSearchClass}
              onSearchChange={setSearch}
            />
            <Select
              value={filter}
              onValueChange={(value) => setFilter(value as GroupFilter)}
            >
              <SelectTrigger
                size="sm"
                className={filterControlClass({ active: filter !== "all" })}
                aria-label={`Filter ${noun.plural}`}
              >
                <SelectValue placeholder={`All ${noun.plural}`} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{`All ${noun.plural}`}</SelectItem>
                <SelectItem value="fully-assigned">Fully assigned</SelectItem>
                <SelectItem value="not-fully-assigned">
                  Not fully assigned
                </SelectItem>
              </SelectContent>
            </Select>
            <Select value={memberFilter} onValueChange={setMemberFilter}>
              <SelectTrigger
                size="sm"
                className={filterControlClass({
                  active: memberFilter !== "all",
                })}
                aria-label="Filter by member"
              >
                <SelectValue placeholder="All members" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All members</SelectItem>
                {memberOptions.map((member) => (
                  <SelectItem key={member.value} value={member.value}>
                    {member.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterBar>
        </CollectionFilters>
      )}

      {userGroups?.truncated && (
        <MembershipTruncationNotice
          totalMemberships={userGroups.totalMemberships}
        />
      )}

      <DataTable
        columns={columns}
        data={visibleGroups}
        isLoading={isFetching}
        emptyMessage={
          isError
            ? `Failed to load ${noun.emptyNoun}. Please try again.`
            : groups.length > 0
              ? `No ${noun.plural} match your search or filter.`
              : `No ${noun.emptyNoun} synced yet. ${capitalizeNoun(noun.plural)} appear after the first permission sync.`
        }
      />
    </div>
  );
}

// ===== Internal pieces =====

function isServiceAccount(member: ConnectorUserGroupMember): boolean {
  return member.accountType === "app";
}

/**
 * The reverse of the mapping the filter options display: a `user:` selection
 * matches every upstream account that resolves to that org user (manual
 * assignment and email match alike), an `account:` selection matches the one
 * unresolved upstream account it names.
 */
function matchesMemberFilter(
  member: ConnectorUserGroupMember,
  filter: string,
): boolean {
  if (filter.startsWith("user:")) {
    return member.user?.id === filter.slice("user:".length);
  }
  if (filter.startsWith("account:")) {
    return !member.user && member.accountId === filter.slice("account:".length);
  }
  return false;
}

/**
 * Assignment buckets over human accounts: fully assigned means every human
 * member resolves to a user (a group with no human members is never "fully
 * assigned" — there is nobody who can reach what it gates).
 */
function matchesFilter(group: ConnectorUserGroup, filter: GroupFilter) {
  if (filter === "all") return true;
  const humans = group.members.filter((m) => !isServiceAccount(m));
  const assigned = humans.filter((m) => m.user).length;
  const fullyAssigned = humans.length > 0 && assigned === humans.length;
  return filter === "fully-assigned" ? fullyAssigned : !fullyAssigned;
}

function matchesSearch(group: ConnectorUserGroup, query: string) {
  if (!query) return true;
  if (
    group.name?.toLowerCase().includes(query) ||
    group.groupId.toLowerCase().includes(query) ||
    group.token.toLowerCase().includes(query)
  ) {
    return true;
  }
  return group.members.some(
    (member) =>
      member.email?.toLowerCase().includes(query) ||
      member.displayName?.toLowerCase().includes(query) ||
      member.accountId.toLowerCase().includes(query) ||
      member.user?.name.toLowerCase().includes(query) ||
      member.user?.email.toLowerCase().includes(query),
  );
}

/**
 * Severity-first default order, so the groups an admin must act on surface
 * without scrolling: (1) groups gating documents that resolve to nobody,
 * (2) then by how many documents the group gates, (3) then by unresolved
 * member count, (4) then alphabetically for a stable tail.
 */
function compareGroupsBySeverity(
  a: ConnectorUserGroup,
  b: ConnectorUserGroup,
): number {
  const severity = (g: ConnectorUserGroup) => {
    const resolved = g.members.filter((m) => m.user).length;
    return g.documentCount > 0 && resolved === 0 ? 1 : 0;
  };
  const unresolvedCount = (g: ConnectorUserGroup) =>
    g.members.filter((m) => !isServiceAccount(m) && !m.user).length;
  return (
    severity(b) - severity(a) ||
    b.documentCount - a.documentCount ||
    unresolvedCount(b) - unresolvedCount(a) ||
    a.groupId.localeCompare(b.groupId)
  );
}

/**
 * The Members cell: `assigned/total assigned` over the group's HUMAN accounts
 * (app/bot accounts never resolve and are not assignable, so they stay out of
 * the counts and the listing), with the roster itself on hover — resolved
 * members as the org user they grant, unresolved ones with the reason. A group
 * that gates documents while resolving to nobody is the one state that makes
 * documents unreachable, so it gets an explicit verdict instead of a count.
 *
 * Hover, not a badge list: naming every member inline cost a third of the
 * table to restate the count beside it, and per-member detail belongs on the
 * Users tab, where a member can actually be assigned.
 */
function GroupMembersSummary({
  group,
  noun,
}: {
  group: ConnectorUserGroup;
  noun: RosterNoun;
}) {
  const humans = group.members.filter((m) => !isServiceAccount(m));
  const assigned = humans.filter((m) => m.user).length;

  if (humans.length === 0) {
    return group.documentCount > 0 ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default text-sm text-amber-600">
            No resolvable members
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Nobody resolves to a user, so documents granting access only through
          this {noun.singular} are inaccessible.
        </TooltipContent>
      </Tooltip>
    ) : (
      <span className="text-sm text-muted-foreground">No members</span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default text-sm underline decoration-dotted underline-offset-4">
          {assigned.toLocaleString()}/{humans.length.toLocaleString()}
          <span className="text-muted-foreground"> assigned</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {humans.map((member) => (
            <div key={member.accountId}>{memberLabel(member)}</div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A resolved member — email-matched or manually assigned alike — reads as the
 * org user it resolves to (email · name), the identity access control
 * actually grants. Only an unresolved member falls back to its upstream
 * identity, with "email hidden" marking why it resolves to nobody.
 */
function memberLabel(member: ConnectorUserGroupMember): string {
  if (member.user) {
    return `${member.user.email} · ${member.user.name}`;
  }
  return (
    member.email ?? `${member.displayName ?? member.accountId} · email hidden`
  );
}
