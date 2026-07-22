// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { UserCog } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { SearchInput } from "@/components/search-input";
import { TableFilters } from "@/components/table-filters";
import { TableRowActions } from "@/components/table-row-actions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
 * gaps; the table mirrors the Settings → Users anatomy: avatar, stacked
 * name-over-email identity cells, badge lists, and a standard Actions column.
 */
export function ConnectorMembersTable({
  connectorId,
}: {
  connectorId: string;
}) {
  const appName = useAppName();
  const { data: userGroups, isPending } = useConnectorUserGroups({
    connectorId,
    enabled: true,
  });
  // The snapshot's resolved user carries only {id, name}; the org member
  // list supplies the email shown under the resolved name.
  const { data: orgMembers } = useOrganizationMembers();
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

  const orgEmailById = useMemo(
    () => new Map((orgMembers ?? []).map((user) => [user.id, user.email])),
    [orgMembers],
  );

  const groupIds = useMemo(
    () =>
      [
        ...new Set((userGroups?.groups ?? []).map((group) => group.groupId)),
      ].sort(),
    [userGroups?.groups],
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
  // (avatar, id, identity) is assigned to which org user, across which
  // groups. Unassigned rows render a plain muted dash; the alert, the
  // Assigned column, its filter, and the Actions column carry the fix.
  const columns = useMemo<ColumnDef<ConnectorMember>[]>(
    () => [
      {
        id: "avatar",
        header: "",
        size: 40,
        cell: ({ row }) => {
          const member = row.original;
          // An assigned account renders as the org user it resolves to;
          // an unassigned one falls back to its upstream identity.
          const name =
            member.user?.name ?? member.displayName ?? member.accountId;
          return (
            <Avatar className="h-8 w-8">
              <AvatarFallback className="text-xs">
                {getInitials(name)}
              </AvatarFallback>
            </Avatar>
          );
        },
      },
      {
        id: "member",
        header: "External User",
        // One identity cell, progressively quieter: name, email, then the
        // upstream account id as a dimmer mono line (full value on hover).
        cell: ({ row }) => (
          <div className="min-w-0">
            <div
              className="truncate text-sm font-medium"
              title={row.original.displayName ?? row.original.accountId}
            >
              {row.original.displayName ?? row.original.accountId}
            </div>
            <div
              className="truncate text-xs text-muted-foreground"
              title={row.original.email ?? undefined}
            >
              {row.original.email ?? "email hidden"}
            </div>
            <div
              className="truncate font-mono text-xs text-muted-foreground/70"
              title={row.original.accountId}
            >
              {row.original.accountId}
            </div>
          </div>
        ),
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
          const email = orgEmailById.get(user.id);
          return (
            <div className="min-w-0">
              <div className="truncate text-sm font-medium" title={user.name}>
                {user.name}
              </div>
              {email && (
                <div
                  className="truncate text-xs text-muted-foreground"
                  title={email}
                >
                  {email}
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
        header: "Groups",
        // Wider than the even share the unsized columns get: two group
        // badges plus the "+N more" badge fit on two lines.
        size: 280,
        cell: ({ row }) => <MemberGroupBadges groups={row.original.groups} />,
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
    [appName, orgEmailById, openAssignDialog],
  );

  return (
    <div>
      {members.length > 0 && (
        <TableFilters>
          <SearchInput
            value={search}
            syncQueryParams={false}
            placeholder="Search by ID, email, name, or group"
            onSearchChange={setSearch}
          />
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as MemberFilter)}
          >
            <SelectTrigger
              className="h-9 w-full text-sm sm:w-[200px]"
              aria-label="Filter users"
            >
              <SelectValue placeholder="All users" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All users</SelectItem>
              <SelectItem value="automatic">Automatically assigned</SelectItem>
              <SelectItem value="manual">Manually assigned</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
            </SelectContent>
          </Select>
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger
              className="h-9 w-full text-sm sm:w-[200px]"
              aria-label="Filter by group"
            >
              <SelectValue placeholder="All groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All groups</SelectItem>
              {groupIds.map((groupId) => (
                <SelectItem key={groupId} value={groupId}>
                  {groupId}
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
        data={visibleMembers}
        isLoading={isPending}
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

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function MemberGroupBadges({ groups }: { groups: string[] }) {
  if (groups.length === 0) {
    return <span className="text-sm text-muted-foreground">-</span>;
  }
  return (
    <CollapsedBadgeList
      items={groups.map((group) => ({ id: group, label: group }))}
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
