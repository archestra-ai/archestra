"use client";

import { E2eTestId } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Copy, Eye, Plus, Shield, Trash2, UserCog } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AuthProviderIcon } from "@/components/auth-provider-icon";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { InviteByLinkCard } from "@/components/invite-by-link-card";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { RoleOptionLabel } from "@/components/role-type-icon";
import { SearchInput } from "@/components/search-input";
import { TableFilters } from "@/components/table-filters";
import { TableRowActions } from "@/components/table-row-actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
import { useDisableInvitations } from "@/lib/config/config.query";
import {
  useImpersonateUser,
  useImpersonationCandidates,
} from "@/lib/impersonation.query";
import {
  type Invitation,
  type Member,
  useCancelInvitationMutation,
  useInvitationsPaginated,
  useMembersPaginated,
  useRemoveMember,
  useUpdateMemberRole,
} from "@/lib/member.query";
import {
  type PendingSignupMember,
  useActiveOrganization,
  useDeletePendingSignupMember,
  useMemberSignupStatus,
} from "@/lib/organization.query";
import { useRoles } from "@/lib/role.query";
import { cn } from "@/lib/utils";
import { useSetSettingsAction } from "../layout";

export default function UsersPageClient() {
  return (
    <ErrorBoundary>
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

  const activeTab = searchParams.get("tab") || "users";

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

  return (
    <LoadingWrapper
      isPending={isOrgPending}
      loadingFallback={<LoadingSpinner />}
    >
      {activeOrg ? (
        <div className="space-y-6">
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

function TabButtons({
  activeTab,
  onTabChange,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-muted p-1">
      <Button
        variant={activeTab === "users" ? "secondary" : "ghost"}
        size="sm"
        onClick={() => onTabChange("users")}
        className={cn("px-3", activeTab === "users" && "shadow-sm")}
      >
        Users
      </Button>
      <Button
        variant={activeTab === "invitations" ? "secondary" : "ghost"}
        size="sm"
        onClick={() => onTabChange("invitations")}
        className={cn("px-3", activeTab === "invitations" && "shadow-sm")}
      >
        Invitations
      </Button>
    </div>
  );
}

function InviteUserButton({ organizationId }: { organizationId: string }) {
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const { data: canInvite } = useHasPermissions({ invitation: ["create"] });
  const disableInvitations = useDisableInvitations();
  const invitationsEnabled =
    disableInvitations === undefined ? false : !disableInvitations;

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
  const removeMember = useRemoveMember();
  const { data: signupStatus } = useMemberSignupStatus();
  const pendingSignupMembers = signupStatus?.pendingSignupMembers ?? [];
  const deletePendingSignupMember = useDeletePendingSignupMember();

  const { data: session } = useSession();
  const currentUserId = session?.user.id;
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
  const tableRows =
    pageIndex === 0 ? [...pendingSignupMembers, ...members] : members;

  const columns: ColumnDef<Member | PendingSignupMember>[] = [
    {
      id: "avatar",
      size: 40,
      header: "",
      cell: ({ row }) => {
        const member = row.original;
        if ("provider" in member) {
          return (
            <div className="flex items-center justify-center">
              <div className="flex h-8 w-8 items-center justify-center rounded-full border bg-muted/40">
                <AuthProviderIcon
                  providerId={member.provider}
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
          {row.original.role}
        </Badge>
      ),
    },
    {
      id: "joined",
      header: "Joined",
      cell: ({ row }) =>
        "provider" in row.original ? (
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
        if ("provider" in member) {
          return (
            <TableRowActions
              actions={[
                {
                  icon: <Copy className="h-4 w-4" />,
                  label: "Copy invitation link",
                  disabled: !member.invitationId,
                  disabledTooltip: member.invitationId
                    ? undefined
                    : "No invitation link available",
                  onClick: async () => {
                    if (!member.invitationId) return;
                    const link = `${window.location.origin}/auth/sign-up-with-invitation?invitationId=${member.invitationId}&email=${encodeURIComponent(member.email)}`;
                    await navigator.clipboard.writeText(link);
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
          member.userId !== currentUserId &&
          impersonableUserIds.has(member.userId);

        return (
          <TableRowActions
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
                      permissions: { member: ["update"] },
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
    <>
      <TableFilters>
        <SearchInput
          objectNamePlural="users"
          searchFields={["name", "email"]}
          paramName="name"
        />
        <RoleFilterDropdown />
        <div className="ml-auto flex items-center gap-2">
          <TabButtons activeTab={activeTab} onTabChange={onTabChange} />
        </div>
      </TableFilters>

      <LoadingWrapper
        isPending={isPending}
        loadingFallback={<LoadingSpinner />}
      >
        <DataTable
          columns={columns}
          data={tableRows}
          manualPagination
          getRowId={(row) =>
            "provider" in row ? `pending-${row.userId}` : row.id
          }
          pagination={{
            pageIndex,
            pageSize,
            total: (pagination?.total || 0) + pendingSignupMembers.length,
          }}
          onPaginationChange={handlePaginationChange}
          isLoading={isFetching}
          hasActiveFilters={Boolean(nameFilter || roleFilter)}
          onClearFilters={() => {
            const params = new URLSearchParams(searchParams.toString());
            params.delete("name");
            params.delete("role");
            params.set("page", "1");
            router.push(`${pathname}?${params.toString()}`, { scroll: false });
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
    </>
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
      <SelectTrigger className="w-[180px]">
        {selectedRole ? (
          <RoleOptionLabel
            predefined={selectedRole.predefined}
            label={selectedRole.name}
            className="pr-6"
          />
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Shield className="h-4 w-4" />
            <SelectValue placeholder="Filter by role" />
          </div>
        )}
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

  const { data: invitationsResponse, isPending } = useInvitationsPaginated({
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
          {row.original.role ?? "member"}
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
    <>
      <div className="flex items-center gap-4 mb-4">
        <div className="ml-auto">
          <TabButtons activeTab={activeTab} onTabChange={onTabChange} />
        </div>
      </div>

      <LoadingWrapper
        isPending={isPending}
        loadingFallback={<LoadingSpinner />}
      >
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
          isLoading={isPending}
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
    </>
  );
}

// ===
// Helpers
// ===

function getInitials(name: string): string {
  return name
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}
