// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { UserCog } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { FormDialog } from "@/components/form-dialog";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
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
import { UserSearchableSelect } from "@/components/user-searchable-select";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import type {
  ConnectorUserGroup,
  ConnectorUserGroupMember,
} from "@/lib/knowledge/connector.query";
import {
  useConnectorUserGroups,
  useDeleteConnectorMemberOverride,
  useUpsertConnectorMemberOverride,
} from "@/lib/knowledge/connector.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { CollapsedBadgeList } from "./collapsed-badge-list";
import { MembershipTruncationNotice } from "./connector-membership-truncation-notice";
import {
  capitalizeNoun,
  GROUP_ROSTER_NOUN,
  type RosterNoun,
} from "./roster-noun";

/** One distinct upstream human account, with every group it appears in. */
interface ConnectorMember extends ConnectorUserGroupMember {
  /** The upstream account id — the stable key a deep link identifies a row by. */
  id: string;
  groups: string[];
}

type MemberFilter = "all" | "automatic" | "manual" | "unassigned";

/**
 * The Users tab: every distinct upstream account seen in the group snapshot,
 * the org user it resolves to at query time (matched by email — the same
 * join access control uses), and the manual-assignment editor for accounts
 * the source hides the email of. An assignment takes precedence over the
 * email join. The page-level unassigned-users alert explains resolution
 * gaps; the table mirrors the Settings → Users anatomy: stacked
 * name-over-email identity cells, badge lists, and a standard Actions column.
 *
 * There is no avatar column: the sources this reads never hand over a picture
 * (the user-groups payload carries an id, a display name and an email), so the
 * circles here were locally-generated initials of the text in the next column.
 */
export function ConnectorMembersTable({
  connectorId,
  noun = GROUP_ROSTER_NOUN,
}: {
  connectorId: string;
  noun?: RosterNoun;
}) {
  const appName = useAppName();
  const { data: userGroups, isFetching } = useConnectorUserGroups({
    connectorId,
    enabled: true,
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<MemberFilter>("all");
  const [groupFilter, setGroupFilter] = useState<string>("all");

  const members = useMemo(
    () => collectDistinctMembers(userGroups?.groups ?? []),
    [userGroups?.groups],
  );

  const memberIdFromUrl = useSearchParams().get("member");
  const memberFromUrl = useMemo(() => {
    const found = members.find((member) => member.id === memberIdFromUrl);
    // Email-matched members can't be reassigned — the row action is disabled
    // for them, so a deep link must not open the editor for one either.
    if (!found || (found.user && found.resolvedVia !== "override")) return null;
    return found;
  }, [members, memberIdFromUrl]);
  const {
    entity: editing,
    open: openAssignDialog,
    close: closeAssignDialog,
  } = useDialogUrlParam({ paramName: "member", entityFromUrl: memberFromUrl });

  const groupIds = useMemo(
    () =>
      [
        ...new Set((userGroups?.groups ?? []).map((group) => group.groupId)),
      ].sort(),
    [userGroups?.groups],
  );

  // Upstream groups carry a numeric id for authorization but a human name for
  // display. Show the name and fall back to the id only when the source never
  // exposed one.
  const groupNameById = useMemo(
    () =>
      new Map(
        (userGroups?.groups ?? []).map((group) => [group.groupId, group.name]),
      ),
    [userGroups?.groups],
  );
  const groupLabel = useCallback(
    (groupId: string) => groupNameById.get(groupId) || groupId,
    [groupNameById],
  );

  const visibleMembers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return members
      .filter((member) => matchesFilter(member, filter))
      .filter(
        (member) =>
          groupFilter === "all" || member.groups.includes(groupFilter),
      )
      .filter((member) => matchesSearch(member, query))
      .sort(compareMembers);
  }, [members, search, filter, groupFilter]);

  // Reading order follows the admin's question: which upstream account
  // is assigned to which org user, across which groups. Unassigned rows render a plain muted dash; the alert, the
  // Assigned column, its filter, and the Actions column carry the fix.
  const columns = useMemo<ColumnDef<ConnectorMember>[]>(
    () => [
      {
        id: "member",
        header: "External User",
        // Name over email, and nothing else: the upstream account id is an
        // opaque string nobody reads down a column, so it moves to the hover
        // (and stays searchable, and is spelled out in the assign dialog).
        cell: ({ row }) => {
          const member = row.original;
          const name = member.displayName ?? member.accountId;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="min-w-0 cursor-default">
                  <div className="truncate text-sm font-medium" title={name}>
                    {name}
                  </div>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={member.email ?? undefined}
                  >
                    {member.email ?? "email hidden"}
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <div className="text-muted-foreground">External ID</div>
                <div className="font-mono">{member.accountId}</div>
              </TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: "resolvesTo",
        header: `${appName} User`,
        cell: ({ row }) => {
          const user = row.original.user;
          if (!user) {
            // Absent value, app-standard rendering: the muted dash IS the
            // "no user" signal; the fix lives in the Actions column.
            return <span className="text-sm text-muted-foreground">-</span>;
          }
          return (
            <div className="min-w-0">
              <div className="truncate text-sm font-medium" title={user.name}>
                {user.name}
              </div>
              {user.email && (
                <div
                  className="truncate text-xs text-muted-foreground"
                  title={user.email}
                >
                  {user.email}
                </div>
              )}
            </div>
          );
        },
      },
      {
        id: "assigned",
        header: "Assigned",
        // Badge hues follow the app's badge palette (resource visibility,
        // connector status): blue for the system's email match, gold for
        // the admin-made assignment.
        cell: ({ row }) => {
          const member = row.original;
          if (!member.user) {
            return (
              <Badge
                variant="outline"
                className="text-xs font-normal text-muted-foreground"
              >
                Unassigned
              </Badge>
            );
          }
          if (member.resolvedVia === "override") {
            return (
              <Badge
                variant="outline"
                className="bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400 dark:border-amber-400/30 text-xs font-normal"
              >
                Manually
              </Badge>
            );
          }
          return (
            <Badge
              variant="outline"
              className="bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-400 dark:border-blue-400/30 text-xs font-normal"
            >
              Automatically
            </Badge>
          );
        },
      },
      {
        id: "groups",
        header: capitalizeNoun(noun.plural),
        // Wider than the even share the unsized columns get: two group
        // badges plus the "+N more" badge fit on two lines.
        size: 280,
        cell: ({ row }) => (
          <MemberGroupBadges
            groups={row.original.groups}
            resolveLabel={groupLabel}
          />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const member = row.original;
          // An email match already agrees with the source identity — it
          // cannot be overridden. Only unassigned accounts and manual
          // assignments are editable; the button stays (disabled) so the
          // column reads uniformly.
          const isEmailMatch = Boolean(
            member.user && member.resolvedVia !== "override",
          );
          return (
            <TableRowActions
              itemName={member.displayName ?? member.accountId}
              actions={[
                {
                  icon: <UserCog className="h-4 w-4" />,
                  label: `Assign ${appName} user`,
                  disabled: isEmailMatch,
                  disabledTooltip:
                    "Assigned automatically by email. Can't reassign",
                  onClick: () => openAssignDialog(member),
                },
              ]}
            />
          );
        },
      },
    ],
    [appName, openAssignDialog, groupLabel, noun],
  );

  return (
    <div>
      {members.length > 0 && (
        <CollectionFilters>
          <FilterBar>
            <SearchInput
              value={search}
              syncQueryParams={false}
              placeholder={`Search by ID, email, name, or ${noun.singular}`}
              className={filterSearchClass}
              onSearchChange={setSearch}
            />
            <Select
              value={filter}
              onValueChange={(value) => setFilter(value as MemberFilter)}
            >
              <SelectTrigger
                size="sm"
                className={filterControlClass({ active: filter !== "all" })}
                aria-label="Filter users"
              >
                <SelectValue placeholder="All users" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All users</SelectItem>
                <SelectItem value="automatic">
                  Automatically assigned
                </SelectItem>
                <SelectItem value="manual">Manually assigned</SelectItem>
                <SelectItem value="unassigned">Unassigned</SelectItem>
              </SelectContent>
            </Select>
            <Select value={groupFilter} onValueChange={setGroupFilter}>
              <SelectTrigger
                size="sm"
                className={filterControlClass({
                  active: groupFilter !== "all",
                })}
                aria-label={`Filter by ${noun.singular}`}
              >
                <SelectValue placeholder={`All ${noun.plural}`} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{`All ${noun.plural}`}</SelectItem>
                {groupIds.map((groupId) => (
                  <SelectItem key={groupId} value={groupId}>
                    {groupLabel(groupId)}
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
        data={visibleMembers}
        isLoading={isFetching}
        emptyMessage={
          members.length > 0
            ? "No users match your search or filter."
            : "No users synced yet. Users appear after the first permission sync."
        }
      />

      {editing && (
        <EditMemberAssignmentDialog
          connectorId={connectorId}
          member={editing}
          onClose={closeAssignDialog}
        />
      )}
    </div>
  );
}

// ===== Internal pieces =====

/**
 * Distinct human accounts across all groups (app/bot accounts never resolve
 * and are not assignable, so they stay out of this table).
 */
function collectDistinctMembers(
  groups: ConnectorUserGroup[],
): ConnectorMember[] {
  const byAccount = new Map<string, ConnectorMember>();
  for (const group of groups) {
    for (const member of group.members) {
      if (member.accountType === "app") continue;
      const existing = byAccount.get(member.accountId);
      if (existing) {
        existing.groups.push(group.groupId);
      } else {
        byAccount.set(member.accountId, {
          ...member,
          id: member.accountId,
          groups: [group.groupId],
        });
      }
    }
  }
  return [...byAccount.values()];
}

// The filter buckets mirror the Assigned column's three values.
function matchesFilter(member: ConnectorMember, filter: MemberFilter) {
  if (filter === "automatic") {
    return Boolean(member.user) && member.resolvedVia !== "override";
  }
  if (filter === "manual") return member.resolvedVia === "override";
  if (filter === "unassigned") return !member.user;
  return true;
}

function matchesSearch(member: ConnectorMember, query: string) {
  if (!query) return true;
  return (
    member.accountId.toLowerCase().includes(query) ||
    member.displayName?.toLowerCase().includes(query) ||
    member.email?.toLowerCase().includes(query) ||
    member.user?.name.toLowerCase().includes(query) ||
    member.user?.email.toLowerCase().includes(query) ||
    member.groups.some((group) => group.toLowerCase().includes(query))
  );
}

/**
 * Automatically assigned (email) first, then manually assigned, then
 * unassigned;
 * alphabetical within each bucket.
 */
function compareMembers(a: ConnectorMember, b: ConnectorMember): number {
  return (
    assignmentRank(a) - assignmentRank(b) ||
    (a.displayName ?? a.accountId).localeCompare(b.displayName ?? b.accountId)
  );
}

function assignmentRank(member: ConnectorMember): number {
  if (!member.user) return 2;
  return member.resolvedVia === "override" ? 1 : 0;
}

function MemberGroupBadges({
  groups,
  resolveLabel,
}: {
  groups: string[];
  resolveLabel: (groupId: string) => string;
}) {
  if (groups.length === 0) {
    return <span className="text-sm text-muted-foreground">-</span>;
  }
  return (
    <CollapsedBadgeList
      items={groups.map((group) => ({ id: group, label: resolveLabel(group) }))}
    />
  );
}

/** Sentinel picker value for "no assignment" — never a real user id. */
const UNASSIGNED_VALUE = "__unassigned__";

function EditMemberAssignmentDialog({
  connectorId,
  member,
  onClose,
}: {
  connectorId: string;
  member: ConnectorMember;
  onClose: () => void;
}) {
  const appName = useAppName();
  const { data: orgMembers, isPending: isMembersPending } =
    useOrganizationMembers();
  const upsertOverride = useUpsertConnectorMemberOverride(connectorId);
  const deleteOverride = useDeleteConnectorMemberOverride(connectorId);
  // The picker always reflects the current state: the overridden user, or
  // the pinned "Unassigned" choice. Removing an assignment is just picking
  // "Unassigned" and saving.
  const initialUserId =
    member.resolvedVia === "override"
      ? (member.user?.id ?? UNASSIGNED_VALUE)
      : UNASSIGNED_VALUE;
  const [selectedUserId, setSelectedUserId] = useState<string>(initialUserId);

  const isDirty = selectedUserId !== initialUserId;
  const isSaving = upsertOverride.isPending || deleteOverride.isPending;
  const memberLabel = member.displayName ?? member.accountId;

  const save = async () => {
    if (!isDirty) return;
    const result =
      selectedUserId === UNASSIGNED_VALUE
        ? await deleteOverride.mutateAsync(member.accountId)
        : await upsertOverride.mutateAsync({
            externalAccountId: member.accountId,
            userId: selectedUserId,
          });
    if (result) onClose();
  };

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Assign ${memberLabel}`}
      description={
        member.resolvedVia === "override"
          ? `Manually assigned. If a sync resolves this account's email to a ${appName} user, the automatic match takes precedence.`
          : member.email
            ? `No ${appName} user matches this email. Pick the user this account belongs to.`
            : `The source hides this user's email, so they can't be matched automatically. Pick the ${appName} user this account belongs to.`
      }
      size="small"
      isDirty={isDirty}
    >
      <DialogForm onSubmit={save}>
        <DialogBody className="space-y-4">
          <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
            <AssignmentDetail
              label="External ID"
              value={member.accountId}
              mono
            />
            <AssignmentDetail label="Name" value={member.displayName ?? "-"} />
            <AssignmentDetail label="Email" value={member.email ?? "hidden"} />
          </div>
          <div className="space-y-2">
            <Label>{appName} user</Label>
            <UserSearchableSelect
              value={selectedUserId}
              onValueChange={setSelectedUserId}
              users={(orgMembers ?? []).map((user) => ({
                userId: user.id,
                name: user.name,
                email: user.email,
              }))}
              pinnedOption={{ value: UNASSIGNED_VALUE, label: "Unassigned" }}
              className="w-full"
              disabled={isMembersPending}
            />
          </div>
        </DialogBody>
        <DialogStickyFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!isDirty || isSaving}>
            Save Changes
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

/** One row of the upstream-account summary in the assignment dialog. */
function AssignmentDetail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 truncate ${mono ? "font-mono text-xs" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
