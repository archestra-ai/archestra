"use client";

import { E2eTestId, getRoleDisplayName } from "@archestra/shared";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import {
  Copy,
  Eye,
  Plus,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCog,
  Users,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AuthProviderIcon } from "@/components/auth-provider-icon";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { FormDialog } from "@/components/form-dialog";
import { InviteByLinkCard } from "@/components/invite-by-link-card";
import { LoadingState, LoadingWrapper } from "@/components/loading";
import { RoleOptionLabel } from "@/components/role-type-icon";
import { SearchInput } from "@/components/search-input";
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
import { TableRowActions } from "@/components/table-row-actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { PermissionButton } from "@/components/ui/permission-button";
import { RoleSelect } from "@/components/ui/role-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { type BulkOutcome, reportBulkOutcome } from "@/lib/bulk-action";
import { copyToClipboard } from "@/lib/clipboard";
import { useDisableInvitations } from "@/lib/config/config.query";
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
import {
  useCanImpersonate,
  useImpersonateUser,
  useImpersonationCandidates,
} from "@/lib/impersonation.query";
import {
  type Invitation,
  type Member,
  useAllMatchingMembers,
  useBulkDeleteMembers,
  useCancelInvitationMutation,
  useInvitationsPaginated,
  useMembersPaginated,
  useRemoveMember,
  useUpdateMemberRole,
} from "@/lib/member.query";
import {
  useActiveOrganization,
  useDeletePendingSignupMember,
  useMemberSignupStatus,
  useOrganization,
} from "@/lib/organization.query";
import { useRoles } from "@/lib/role.query";
import { cn } from "@/lib/utils";
import { useSetSettingsAction } from "../layout";

export default function UsersPageClient() {
  return (
    <ErrorBoundary>
      <SmallTeamTierBanner />
      <UsersPageContent />
    </ErrorBoundary>
  );
}

function UsersPageContent() {
  const setActionButton = useSetSettingsAction();
  const { data: activeOrg, isPending: isOrgPending } = useActiveOrganization();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const invitationsEnabled = useInvitationsEnabled();
  // A deployment with invitations turned off has no invitations tab to select,
  // so a `?tab=invitations` link (a bookmark, or one shared before the flag was
  // flipped) resolves to the users tab rather than an unreachable panel.
  const tabFromUrl = searchParams.get("tab") || "users";
  const activeTab =
    tabFromUrl === "invitations" && invitationsEnabled
      ? "invitations"
      : "users";

  const setActiveTab = useCallback(
    (tab: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", tab);
      params.delete("page");
      params.delete("name");
      params.delete("role");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  useEffect(() => {
    setActionButton(
      activeOrg ? <InviteUserButton organizationId={activeOrg.id} /> : null,
    );

    return () => setActionButton(null);
  }, [activeOrg, setActionButton]);

  // With invitations off there is only one thing to show, so no tablist is
  // rendered — and a tabpanel whose aria-labelledby points at a tab button that
  // does not exist is worse than a plain container.
  const tabPanelProps = invitationsEnabled
    ? ({
        // Single always-mounted panel keeps each tab's aria-controls
        // pointing at an element that exists (the panel's content swaps).
        role: "tabpanel",
        id: USERS_TABPANEL_ID,
        "aria-labelledby": `${activeTab}-tab`,
      } as const)
    : {};

  return (
    <LoadingWrapper isPending={isOrgPending} loadingFallback={<LoadingState />}>
      {activeOrg ? (
        <div className="space-y-6" {...tabPanelProps}>
          {activeTab === "users" ? (
            <MembersTab activeTab={activeTab} onTabChange={setActiveTab} />
          ) : (
            <InvitationsTab activeTab={activeTab} onTabChange={setActiveTab} />
          )}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">
          You are not part of any organization yet. Please refresh or sign in
          again.
        </div>
      )}
    </LoadingWrapper>
  );
}

const USERS_TABPANEL_ID = "users-tabpanel";

const USER_TABS = [
  { id: "users", label: "Users" },
  { id: "invitations", label: "Invitations" },
] as const;

/**
 * Whether this deployment can invite anyone at all.
 *
 * Invitations are a deployment-level switch
 * (`ARCHESTRA_AUTH_DISABLE_INVITATIONS`), not a permission: with them off the
 * invite endpoints refuse, so every invitation affordance — the invite button
 * and the invitations tab — stays hidden rather than leading somewhere that
 * cannot work. `undefined` means the public config is still in flight; treat
 * that as off so the affordance never flashes in and then disappears.
 */
function useInvitationsEnabled() {
  const disableInvitations = useDisableInvitations();
  return disableInvitations === undefined ? false : !disableInvitations;
}

function TabButtons({
  activeTab,
  onTabChange,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
}) {
  const invitationsEnabled = useInvitationsEnabled();
  const tabs = USER_TABS.filter(
    (tab) => tab.id !== "invitations" || invitationsEnabled,
  );

  // Switching tabs swaps the whole MembersTab/InvitationsTab subtree —
  // including this component — so the newly active tab button must be
  // re-focused after the replacement mounts or keyboard focus drops to <body>.
  const selectTab = (tabId: string) => {
    onTabChange(tabId);
    requestAnimationFrame(() => {
      document.getElementById(`${tabId}-tab`)?.focus();
    });
  };

  // A switcher with a single destination is a label, not a control.
  if (tabs.length < 2) return null;

  return (
    <div
      role="tablist"
      aria-label="Users and invitations"
      // `h-8 p-0.5` keeps the switcher level with the filter bar's controls;
      // the stock `p-1` around size-sm buttons stands 8px taller than the row.
      className="flex h-8 items-center gap-1 rounded-lg bg-muted p-0.5"
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <Button
            key={tab.id}
            role="tab"
            id={`${tab.id}-tab`}
            aria-selected={isActive}
            aria-controls={USERS_TABPANEL_ID}
            tabIndex={isActive ? 0 : -1}
            variant={isActive ? "secondary" : "ghost"}
            size="sm"
            onClick={() => selectTab(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                selectTab(tab.id === "users" ? "invitations" : "users");
              }
            }}
            className={cn("h-7 px-3", isActive && "shadow-sm")}
          >
            {tab.label}
          </Button>
        );
      })}
    </div>
  );
}

function InviteUserButton({ organizationId }: { organizationId: string }) {
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const { data: canInvite } = useHasPermissions({ invitation: ["create"] });
  const invitationsEnabled = useInvitationsEnabled();

  if (!invitationsEnabled || !canInvite) return null;

  return (
    <>
      <PermissionButton
        permissions={{ invitation: ["create"] }}
        onClick={() => setInviteDialogOpen(true)}
      >
        <Plus className="h-4 w-4" />
        Invite User
      </PermissionButton>

      <FormDialog
        open={inviteDialogOpen}
        onOpenChange={setInviteDialogOpen}
        title="Invite User"
        size="small"
      >
        <InviteByLinkCard organizationId={organizationId} />
      </FormDialog>
    </>
  );
}

// ===
// Members Tab
// ===

function MembersTab({
  activeTab,
  onTabChange,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { data: organization } = useOrganization();

  const pageFromUrl = searchParams.get("page");
  const limitFromUrl = searchParams.get("limit");
  const nameFilter = searchParams.get("name") || "";
  const roleFilter = searchParams.get("role") || "";

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(limitFromUrl) || DEFAULT_TABLE_LIMIT;
  const offset = pageIndex * pageSize;

  const {
    data: membersResponse,
    isPending,
    isFetching,
  } = useMembersPaginated({
    limit: pageSize,
    offset,
    name: nameFilter || undefined,
    role: roleFilter || undefined,
  });

  const updateMemberRole = useUpdateMemberRole();
  const bulkDeleteMembers = useBulkDeleteMembers();
  const removeMember = useRemoveMember();
  const { data: signupStatus } = useMemberSignupStatus();
  const pendingSignupMembers = signupStatus?.pendingSignupMembers ?? [];
  const deletePendingSignupMember = useDeletePendingSignupMember();

  const { data: session } = useSession();
  const currentUserId = session?.user.id;
  const canImpersonate = useCanImpersonate();
  const { data: impersonationCandidates } = useImpersonationCandidates();
  const impersonableUserIds = new Set(
    (impersonationCandidates ?? []).map((c) => c.id),
  );
  const { mutate: impersonateUser, isPending: isImpersonatingUser } =
    useImpersonateUser();

  const [changingRole, setChangingRole] = useState<{
    member: Member;
    newRole: string;
  } | null>(null);
  const [removingMember, setRemovingMember] = useState<Member | null>(null);

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      if (newPagination.pageSize !== DEFAULT_TABLE_LIMIT) {
        params.set("limit", String(newPagination.pageSize));
      } else {
        params.delete("limit");
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const members = membersResponse?.data || [];
  const pagination = membersResponse?.pagination;

  /**
   * Pending-signup users are ordinary rows of the `member` table — the
   * signup-status endpoint just reports which of them have no account record
   * yet — so `/api/members` already returns them, on whichever page they sort
   * onto. Their pending-ness is therefore an attribute of a member row, looked
   * up here, and never a row of its own: prepending them produced a duplicate
   * of each on page one, a first page longer than the page size, and a total
   * inflated past the real member count, which in turn advertised a trailing
   * page whose offset lands beyond the last member and renders empty.
   */
  const pendingSignupByUserId = new Map(
    pendingSignupMembers.map((pending) => [pending.userId, pending]),
  );
  const pendingSignupFor = (member: Member) =>
    pendingSignupByUserId.get(member.userId);

  // Show the column while the requirement is on, and keep showing it once
  // anyone is enrolled — turning the requirement off should not blind admins
  // to who still has 2FA.
  const showTwoFactorColumn =
    !!organization?.requireTwoFactor ||
    members.some((member) => member.twoFactorEnabled);

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkRemoveOpen, setBulkRemoveOpen] = useState(false);
  const clearSelection = useCallback(() => {
    setRowSelection({});
    setEscalatedFor(null);
  }, []);

  /**
   * Your own membership is never part of a selection — removing yourself from
   * the organization mid-batch would revoke the session doing the removing.
   */
  const isSelf = (row: Member) => row.userId === currentUserId;

  const filterSignature = JSON.stringify({ nameFilter, roleFilter });
  const [escalatedFor, setEscalatedFor] = useState<string | null>(null);
  const allMatchingSelected = escalatedFor === filterSignature;
  const { effectiveRowSelection, onRowSelectionChange } =
    useControlledRowSelection({
      rowSelection,
      setRowSelection,
      rows: members,
      getRowId: (row) => row.id,
      allMatchingSelected,
      clearEscalation: () => setEscalatedFor(null),
      canSelect: (row) => !isSelf(row),
    });
  const { data: allMatchingMembers, isFetching: isFetchingAllMatching } =
    useAllMatchingMembers(
      { name: nameFilter || undefined, role: roleFilter || undefined },
      { enabled: allMatchingSelected },
    );

  const pageSelection = members.filter(
    (row) => !isSelf(row) && effectiveRowSelection[row.id],
  );
  const selectedMembers =
    allMatchingSelected && allMatchingMembers
      ? allMatchingMembers.filter((row) => !isSelf(row))
      : pageSelection;

  const selectableTotal = allMatchingMembers
    ? allMatchingMembers.filter((row) => !isSelf(row)).length
    : Math.max(0, (pagination?.total ?? 0) - (members.some(isSelf) ? 1 : 0));

  const columns: ColumnDef<Member>[] = [
    createSelectColumn<Member>({
      rowLabel: (row) => `Select ${row.email}`,
      allLabel: "Select all users on this page",
      canSelect: (row) => !isSelf(row),
      disabledReason: () => "You cannot remove your own account",
    }),
    {
      id: "avatar",
      size: 40,
      header: "",
      cell: ({ row }) => {
        const member = row.original;
        const pending = pendingSignupFor(member);
        if (pending) {
          return (
            <div className="flex items-center justify-center">
              <div className="flex h-8 w-8 items-center justify-center rounded-full border bg-muted/40">
                <AuthProviderIcon
                  providerId={pending.provider}
                  size={16}
                  className="rounded-sm"
                />
              </div>
            </div>
          );
        }

        const initials = getInitials(member.name || member.email);
        return (
          <div className="flex items-center justify-center">
            <Avatar className="h-8 w-8">
              {member.image && (
                <AvatarImage
                  src={member.image}
                  alt={member.name ?? undefined}
                />
              )}
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
          </div>
        );
      },
    },
    {
      id: "user",
      header: "User",
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium truncate">
            {row.original.name || "Unknown"}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {row.original.email}
          </div>
        </div>
      ),
    },
    {
      id: "role",
      header: "Role",
      cell: ({ row }) => (
        <Badge variant="outline" className="capitalize">
          {getRoleDisplayName(row.original.role)}
        </Badge>
      ),
    },
    ...(showTwoFactorColumn
      ? [
          {
            id: "twoFactor",
            header: "2FA",
            cell: ({ row }) =>
              pendingSignupFor(row.original) ? (
                <span className="text-sm text-muted-foreground">—</span>
              ) : row.original.twoFactorEnabled ? (
                <span
                  className="inline-flex items-center gap-1 text-sm text-green-600 dark:text-green-500"
                  title="Two-factor authentication enrolled"
                >
                  <ShieldCheck className="h-4 w-4" />
                  <span>Enrolled</span>
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 text-sm text-amber-600 dark:text-amber-500"
                  title="Not yet enrolled — signed out until they set 2FA up"
                >
                  <ShieldAlert className="h-4 w-4" />
                  <span>Not enrolled</span>
                </span>
              ),
          } satisfies ColumnDef<Member>,
        ]
      : []),
    {
      id: "joined",
      header: "Joined",
      cell: ({ row }) =>
        pendingSignupFor(row.original) ? (
          <span className="text-sm text-muted-foreground">
            Pending (auto-provisioned)
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">
            {formatDistanceToNow(new Date(row.original.createdAt), {
              addSuffix: true,
            })}
          </span>
        ),
    },
    {
      id: "actions",
      header: "Actions",
      enableHiding: false,
      cell: ({ row }) => {
        const member = row.original;
        const pending = pendingSignupFor(member);
        if (pending) {
          return (
            <TableRowActions
              itemName={member.email}
              actions={[
                {
                  icon: <Copy className="h-4 w-4" />,
                  label: "Copy invitation link",
                  disabled: !pending.invitationId,
                  disabledTooltip: pending.invitationId
                    ? undefined
                    : "No invitation link available",
                  onClick: async () => {
                    if (!pending.invitationId) return;
                    const link = `${window.location.origin}/auth/sign-up-with-invitation?invitationId=${pending.invitationId}&email=${encodeURIComponent(member.email)}`;
                    await copyToClipboard(link);
                  },
                },
                {
                  icon: <Trash2 className="h-4 w-4" />,
                  label: "Remove pending user",
                  variant: "destructive",
                  permissions: { member: ["delete"] },
                  onClick: () =>
                    deletePendingSignupMember.mutate(member.userId),
                },
              ]}
            />
          );
        }

        const canImpersonateThisUser =
          canImpersonate &&
          member.userId !== currentUserId &&
          impersonableUserIds.has(member.userId);

        return (
          <TableRowActions
            itemName={member.email}
            actions={[
              {
                icon: <UserCog className="h-4 w-4" />,
                label: "Change role",
                permissions: { member: ["update"] },
                onClick: () =>
                  setChangingRole({ member, newRole: member.role }),
              },
              ...(canImpersonateThisUser
                ? [
                    {
                      icon: <Eye className="h-4 w-4" />,
                      label: "View as user",
                      permissions: { member: ["impersonate"] },
                      disabled: isImpersonatingUser,
                      testId: `${E2eTestId.ImpersonationViewAsButton}-${member.userId}`,
                      onClick: () => impersonateUser(member.userId),
                    },
                  ]
                : []),
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Remove user",
                variant: "destructive",
                permissions: { member: ["delete"] },
                onClick: () => setRemovingMember(member),
              },
            ]}
          />
        );
      },
    },
  ];

  return (
    <BulkActionsScope>
      <CollectionFilters>
        <FilterBar
          actions={
            <TabButtons activeTab={activeTab} onTabChange={onTabChange} />
          }
        >
          <SearchInput
            isLoading={isFetching}
            objectNamePlural="users"
            searchFields={["name", "email"]}
            paramName="name"
            className={filterSearchClass}
          />
          <RoleFilterDropdown />
        </FilterBar>
      </CollectionFilters>

      <LoadingWrapper isPending={isPending} loadingFallback={<LoadingState />}>
        <BulkActions
          count={selectedMembers.length}
          noun="user"
          onClear={clearSelection}
          busy={bulkDeleteMembers.isPending || isFetchingAllMatching}
          selectAllMatching={{
            total: selectableTotal,
            pageFullySelected:
              members.length > 0 &&
              members
                .filter((row) => !isSelf(row))
                .every((row) => effectiveRowSelection[row.id]),
            active: allMatchingSelected,
            onSelectAll: () => setEscalatedFor(filterSignature),
            matchDescription: nameFilter
              ? "match this search query"
              : "match the current filters",
          }}
        >
          <PermissionButton
            permissions={{ member: ["delete"] }}
            variant="destructive"
            size="sm"
            onClick={() => setBulkRemoveOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            <span>Remove</span>
          </PermissionButton>
        </BulkActions>

        <DataTable
          columns={columns}
          data={members}
          rowSelection={effectiveRowSelection}
          onRowSelectionChange={onRowSelectionChange}
          hideSelectedCount
          manualPagination
          getRowId={(row) => row.id}
          pagination={{
            pageIndex,
            pageSize,
            total: pagination?.total || 0,
          }}
          onPaginationChange={handlePaginationChange}
          isLoading={isFetching}
          hasActiveFilters={Boolean(nameFilter || roleFilter)}
          onClearFilters={() => {
            const params = new URLSearchParams(searchParams.toString());
            params.delete("name");
            params.delete("role");
            params.set("page", "1");
            router.push(`${pathname}?${params.toString()}`, {
              scroll: false,
            });
          }}
        />
      </LoadingWrapper>
      {/* Change Role Dialog */}
      {changingRole && (
        <ChangeRoleDialog
          member={changingRole.member}
          open={!!changingRole}
          onOpenChange={(open) => !open && setChangingRole(null)}
          onConfirm={async (newRole) => {
            await updateMemberRole.mutateAsync({
              memberId: changingRole.member.id,
              role: newRole,
            });
            setChangingRole(null);
          }}
          isPending={updateMemberRole.isPending}
        />
      )}

      {bulkRemoveOpen && (
        <DeleteConfirmDialog
          open={bulkRemoveOpen}
          onOpenChange={setBulkRemoveOpen}
          title="Remove users"
          description={`Remove ${selectedMembers.length} ${
            selectedMembers.length === 1 ? "user" : "users"
          } from the organization? Pending invitations are withdrawn; accepted members lose access.`}
          isPending={bulkDeleteMembers.isPending}
          onConfirm={() => {
            const labels = new Map(
              selectedMembers.map((member) => [
                pendingSignupFor(member)
                  ? `pendingSignup:${member.userId}`
                  : `member:${member.id}`,
                member.email,
              ]),
            );
            bulkDeleteMembers.mutate(
              selectedMembers.map((member) =>
                pendingSignupFor(member)
                  ? { kind: "pendingSignup" as const, id: member.userId }
                  : { kind: "member" as const, id: member.id },
              ),
              {
                onSuccess: (outcome) => {
                  reportBulkOutcome({
                    outcome: toBulkOutcome(outcome, labels),
                    verb: "Removed",
                    failureVerb: "remove",
                    noun: "user",
                  });
                  setBulkRemoveOpen(false);
                  if (outcome.failed.length === 0) clearSelection();
                },
              },
            );
          }}
          confirmLabel="Remove users"
          pendingLabel="Removing..."
        />
      )}

      {removingMember && (
        <DeleteConfirmDialog
          open={!!removingMember}
          onOpenChange={(open) => !open && setRemovingMember(null)}
          title="Remove User"
          description={`Are you sure you want to remove ${removingMember.name || removingMember.email} from the organization? This action cannot be undone.`}
          isPending={removeMember.isPending}
          onConfirm={async () => {
            await removeMember.mutateAsync(removingMember.id);
            setRemovingMember(null);
          }}
          confirmLabel="Remove"
          pendingLabel="Removing..."
        />
      )}
    </BulkActionsScope>
  );
}

function RoleFilterDropdown() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { data: roles = [] } = useRoles();

  const currentRole = searchParams.get("role") || "all";
  const selectedRole = roles.find((role) => role.role === currentRole);

  const handleChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "all") {
        params.delete("role");
      } else {
        params.set("role", value);
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  return (
    <Select value={currentRole} onValueChange={handleChange}>
      <SelectTrigger
        size="sm"
        className={filterControlClass({ active: currentRole !== "all" })}
        data-testid={E2eTestId.UsersRoleFilter}
      >
        {/*
         * SelectValue must stay mounted in every state. Radix positions the
         * item-aligned dropdown only once it has all of trigger, value node,
         * content, viewport and selected item; with the value node missing it
         * silently skips positioning and the list renders unstyled off-screen
         * while `pointer-events: none` stays on <body> — so the filter looks
         * dead. Rendering the custom label as SelectValue's children keeps the
         * node mounted, which is the same shape the other custom-label selects
         * here use.
         */}
        <SelectValue placeholder="Filter by role">
          {selectedRole ? (
            <RoleOptionLabel
              predefined={selectedRole.predefined}
              label={selectedRole.name}
              className="pr-6"
            />
          ) : (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Shield className="h-4 w-4" />
              Filter by role
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Roles</SelectItem>
        {roles.map((role) => (
          <SelectItem key={role.id} value={role.role}>
            <RoleOptionLabel predefined={role.predefined} label={role.name} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ChangeRoleDialog({
  member,
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: {
  member: Member;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (role: string) => void;
  isPending: boolean;
}) {
  const [selectedRole, setSelectedRole] = useState(member.role);

  useEffect(() => {
    setSelectedRole(member.role);
  }, [member.role]);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change Role"
      description={
        <>
          Update the role for{" "}
          <span className="font-medium text-foreground">
            {member.name || member.email}
          </span>
        </>
      }
      size="small"
    >
      <DialogBody className="space-y-4">
        <RoleSelect
          value={selectedRole}
          onValueChange={setSelectedRole}
          ariaLabel="Role"
          className="w-full"
        />
      </DialogBody>
      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          onClick={() => onConfirm(selectedRole)}
          disabled={isPending || selectedRole === member.role}
        >
          {isPending ? "Updating..." : "Update Role"}
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

// ===
// Invitations Tab
// ===

function InvitationsTab({
  activeTab,
  onTabChange,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const pageFromUrl = searchParams.get("page");
  const limitFromUrl = searchParams.get("limit");
  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(limitFromUrl) || DEFAULT_TABLE_LIMIT;
  const offset = pageIndex * pageSize;

  const {
    data: invitationsResponse,
    isPending,
    isFetching,
  } = useInvitationsPaginated({
    limit: pageSize,
    offset,
  });

  const cancelInvitation = useCancelInvitationMutation();
  const [cancellingInvitation, setCancellingInvitation] =
    useState<Invitation | null>(null);

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      params.set("tab", "invitations");
      if (newPagination.pageSize !== DEFAULT_TABLE_LIMIT) {
        params.set("limit", String(newPagination.pageSize));
      } else {
        params.delete("limit");
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const invitations = invitationsResponse?.data || [];
  const pagination = invitationsResponse?.pagination;

  const columns: ColumnDef<Invitation>[] = [
    {
      id: "email",
      header: "Email",
      cell: ({ row }) => (
        <span className="font-medium">{row.original.email}</span>
      ),
    },
    {
      id: "role",
      header: "Role",
      cell: ({ row }) => (
        <Badge variant="outline" className="capitalize">
          {getRoleDisplayName(row.original.role ?? "member")}
        </Badge>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => {
        const isExpired = new Date(row.original.expiresAt) < new Date();
        return (
          <Badge variant={isExpired ? "destructive" : "secondary"}>
            {isExpired
              ? "Expired"
              : row.original.status.charAt(0).toUpperCase() +
                row.original.status.slice(1).toLowerCase()}
          </Badge>
        );
      },
    },
    {
      id: "expires",
      header: "Expires",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatDistanceToNow(new Date(row.original.expiresAt), {
            addSuffix: true,
          })}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      enableHiding: false,
      cell: ({ row }) => (
        <TableRowActions
          itemName={row.original.email}
          actions={[
            {
              icon: <Trash2 className="h-4 w-4" />,
              label: "Cancel invitation",
              variant: "destructive",
              permissions: { invitation: ["cancel"] },
              onClick: () => setCancellingInvitation(row.original),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <div>
      <CollectionFilters>
        <FilterBar
          actions={
            <TabButtons activeTab={activeTab} onTabChange={onTabChange} />
          }
        />
      </CollectionFilters>

      <LoadingWrapper isPending={isPending} loadingFallback={<LoadingState />}>
        <DataTable
          columns={columns}
          data={invitations}
          manualPagination
          pagination={{
            pageIndex,
            pageSize,
            total: pagination?.total || 0,
          }}
          onPaginationChange={handlePaginationChange}
          isLoading={isFetching}
          emptyIcon={Users}
          emptyMessage="No invitations"
        />
      </LoadingWrapper>

      {cancellingInvitation && (
        <DeleteConfirmDialog
          open={!!cancellingInvitation}
          onOpenChange={(open) => !open && setCancellingInvitation(null)}
          title="Cancel Invitation"
          description={`Are you sure you want to cancel the invitation for ${cancellingInvitation.email}?`}
          isPending={cancelInvitation.isPending}
          onConfirm={async () => {
            await cancelInvitation.mutateAsync(cancellingInvitation.id);
            setCancellingInvitation(null);
          }}
          confirmLabel="Cancel Invitation"
          pendingLabel="Cancelling..."
        />
      )}
    </div>
  );
}

// ===
// Helpers
// ===

function toBulkOutcome(
  outcome: {
    succeeded: Array<{ kind: string; id: string }>;
    failed: Array<{ kind: string; id: string; error: string }>;
  },
  labels: ReadonlyMap<string, string>,
): BulkOutcome {
  const labelFor = (target: { kind: string; id: string }) =>
    labels.get(`${target.kind}:${target.id}`) ?? "Unknown";
  return {
    succeeded: outcome.succeeded.map(labelFor),
    failed: outcome.failed.map((target) => ({
      label: labelFor(target),
      error: target.error,
    })),
  };
}

function getInitials(name: string): string {
  return name
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}
