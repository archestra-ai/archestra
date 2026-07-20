// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Clock, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { SearchInput } from "@/components/search-input";
import { TableFilters } from "@/components/table-filters";
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
import { formatDate } from "@/lib/utils";
import { CollapsedBadgeList } from "./collapsed-badge-list";
import { MembershipTruncationNotice } from "./connector-membership-truncation-notice";

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
}: {
  connectorId: string;
}) {
  const {
    data: userGroups,
    isPending,
    isError,
  } = useConnectorUserGroups({ connectorId, enabled: true });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<GroupFilter>("all");
  const [memberFilter, setMemberFilter] = useState<string>("all");

  const groups = useMemo(() => userGroups?.groups ?? [], [userGroups?.groups]);

  // Distinct human accounts across the snapshot, for the member filter.
  const memberOptions = useMemo(() => {
    const byAccount = new Map<string, string>();
    for (const group of groups) {
      for (const member of group.members) {
        if (isServiceAccount(member)) continue;
        byAccount.set(
          member.accountId,
          member.displayName ?? member.email ?? member.accountId,
        );
      }
    }
    return [...byAccount.entries()]
      .map(([accountId, label]) => ({ accountId, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [groups]);

  const visibleGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    return groups
      .filter((group) => matchesFilter(group, filter))
      .filter(
        (group) =>
          memberFilter === "all" ||
          group.members.some((member) => member.accountId === memberFilter),
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
        header: "Group",
        // Group ids run long (e.g. `confluence-user-access-admins-…`); a
        // fixed wide column keeps them readable instead of truncating at
        // the even share.
        size: 320,
        cell: ({ row }) => (
          <div className="min-w-0">
            <div
              className="truncate text-sm font-medium"
              title={row.original.groupId}
            >
              {row.original.groupId}
            </div>
            <div
              className="truncate text-xs text-muted-foreground"
              title={row.original.token}
            >
              {row.original.token}
            </div>
          </div>
        ),
      },
      {
        id: "documentCount",
        accessorKey: "documentCount",
        header: "Documents",
        size: 90,
        cell: ({ row }) => (
          <span className="text-sm">
            {row.original.documentCount.toLocaleString()}
          </span>
        ),
      },
      {
        id: "assigned",
        header: "Assigned",
        size: 110,
        cell: ({ row }) => <GroupMembersSummary group={row.original} />,
      },
      {
        id: "members",
        header: "Members",
        // Like the documents table's Access column. Deliberately the widest
        // size: under table-fixed the browser distributes leftover width
        // proportionally to the declared sizes, and the badges are the one
        // cell that can use it — the counter columns must stay compact.
        size: 480,
        cell: ({ row }) => <GroupMemberBadges group={row.original} />,
      },
      {
        id: "lastSyncedAt",
        accessorKey: "lastSyncedAt",
        header: "Last Synced",
        size: 140,
        cell: ({ row }) =>
          row.original.lastSyncedAt ? (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              <span title={formatDate({ date: row.original.lastSyncedAt })}>
                {formatDistanceToNow(new Date(row.original.lastSyncedAt), {
                  addSuffix: true,
                })}
              </span>
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">-</span>
          ),
      },
    ],
    [],
  );

  return (
    <div>
      {groups.length > 0 && (
        <TableFilters>
          <SearchInput
            value={search}
            syncQueryParams={false}
            placeholder="Search by group or member name"
            onSearchChange={setSearch}
          />
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as GroupFilter)}
          >
            <SelectTrigger
              className="h-9 w-full text-sm sm:w-[200px]"
              aria-label="Filter groups"
            >
              <SelectValue placeholder="All groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All groups</SelectItem>
              <SelectItem value="fully-assigned">Fully assigned</SelectItem>
              <SelectItem value="not-fully-assigned">
                Not fully assigned
              </SelectItem>
            </SelectContent>
          </Select>
          <Select value={memberFilter} onValueChange={setMemberFilter}>
            <SelectTrigger
              className="h-9 w-full text-sm sm:w-[200px]"
              aria-label="Filter by member"
            >
              <SelectValue placeholder="All members" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All members</SelectItem>
              {memberOptions.map((member) => (
                <SelectItem key={member.accountId} value={member.accountId}>
                  {member.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </TableFilters>
      )}

      {userGroups?.truncated && (
        <MembershipTruncationNotice
          totalMemberships={userGroups.totalMemberships}
        />
      )}

      <DataTable
        columns={columns}
        data={visibleGroups}
        isLoading={isPending}
        emptyMessage={
          isError
            ? "Failed to load user groups. Please try again."
            : groups.length > 0
              ? "No groups match your search or filter."
              : "No user groups synced yet. Groups appear after the first permission sync."
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
      member.user?.name.toLowerCase().includes(query),
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
 * Compact membership summary: `assigned/total assigned` over the group's
 * HUMAN accounts (app/bot accounts never resolve and are not assignable, so
 * they stay out of the counts — the hover tooltip still lists them,
 * labeled), with the full member list on hover. A group that gates
 * documents while resolving to nobody is the one state that makes documents
 * unreachable, so it gets an explicit verdict instead of a count.
 */
function GroupMembersSummary({ group }: { group: ConnectorUserGroup }) {
  const humans = group.members.filter((m) => !isServiceAccount(m));
  const assigned = humans.filter((m) => m.user).length;

  if (humans.length === 0) {
    return group.documentCount > 0 ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default text-sm text-muted-foreground">
            No resolvable members
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Nobody resolves to a user, so documents granting access only through
          this group are inaccessible.
        </TooltipContent>
      </Tooltip>
    ) : (
      <span className="text-sm text-muted-foreground">No members</span>
    );
  }

  return (
    <span className="text-sm">
      {assigned.toLocaleString()}/{humans.length.toLocaleString()}
      <span className="text-muted-foreground"> assigned</span>
    </span>
  );
}

/**
 * App/bot accounts are excluded — they never sign in, so they are noise here
 * (the Assigned counts skip them too).
 */
function GroupMemberBadges({ group }: { group: ConnectorUserGroup }) {
  const humans = group.members.filter((m) => !isServiceAccount(m));
  if (humans.length === 0) {
    return <span className="text-sm text-muted-foreground">-</span>;
  }
  return (
    <CollapsedBadgeList
      items={humans.map((member) => ({
        id: member.accountId,
        label: memberLabel(member),
      }))}
    />
  );
}

function memberLabel(member: ConnectorUserGroupMember): string {
  const identity =
    member.email ?? `${member.displayName ?? member.accountId} · email hidden`;
  return member.user ? `${identity} · ${member.user.name}` : identity;
}
