"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { InvitationsList } from "@/components/invitations-list";
import { InviteByLinkCard } from "@/components/invite-by-link-card";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MultiSelect } from "@/components/ui/multi-select";
import { PermissionButton } from "@/components/ui/permission-button";
import { RoleSelect } from "@/components/ui/role-select";
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
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TooltipButton } from "@/components/ui/tooltip-button";
import { useHasPermissions } from "@/lib/auth.query";
import config from "@/lib/config";
import {
  organizationKeys,
  type PaginatedMember,
  useActiveOrganization,
  useDeletePendingSignupMember,
  useMemberSignupStatus,
  useOrganizationMembersPaginated,
  useRemoveMember,
  useUpdateMemberRole,
} from "@/lib/organization.query";
import { useRoles } from "@/lib/role.query";
import { useTeams } from "@/lib/team.query";
import {
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_TABLE_LIMIT,
  formatDate,
} from "@/lib/utils";

function SortIcon({ isSorted }: { isSorted: false | "asc" | "desc" }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") {
    return upArrow;
  }
  if (isSorted === "desc") {
    return downArrow;
  }
  return (
    <div className="text-muted-foreground/50 flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}

function TeamsBadges({
  teams,
}: {
  teams: Array<{ id: string; name: string }>;
}) {
  const MAX_TEAMS_TO_SHOW = 3;

  if (!teams || teams.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }

  const visibleTeams = teams.slice(0, MAX_TEAMS_TO_SHOW);
  const remainingTeams = teams.slice(MAX_TEAMS_TO_SHOW);

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visibleTeams.map((team) => (
        <Badge key={team.id} variant="secondary" className="text-xs gap-1">
          <Users className="h-3 w-3" />
          {team.name}
        </Badge>
      ))}
      {remainingTeams.length > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground cursor-help">
                +{remainingTeams.length} more
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="flex flex-col gap-1">
                {remainingTeams.map((team) => (
                  <div key={team.id} className="text-xs">
                    {team.name}
                  </div>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

function MembersSettingsContent() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const { data: activeOrg, isPending: isOrgPending } = useActiveOrganization();
  const { data: canInvite } = useHasPermissions({ invitation: ["create"] });
  const { data: canManageMembers } = useHasPermissions({
    member: ["update"],
  });
  const invitationsEnabled = !config.disableInvitations;

  // URL params
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const searchFilter = searchParams.get("search") || "";
  const sortByFromUrl = searchParams.get("sortBy") as
    | "name"
    | "email"
    | "role"
    | "createdAt"
    | null;
  const sortDirectionFromUrl = searchParams.get("sortDirection") as
    | "asc"
    | "desc"
    | null;
  const teamIdsFromUrl = searchParams.get("teamIds");
  const roleFromUrl = searchParams.get("role");

  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);
  const pageIndex = Number(pageFromUrl || "1") - 1;
  const offset = pageIndex * pageSize;

  const sortBy = sortByFromUrl || DEFAULT_SORT_BY;
  const sortDirection = sortDirectionFromUrl || DEFAULT_SORT_DIRECTION;

  const { data: membersResponse, isPending: isMembersPending } =
    useOrganizationMembersPaginated({
      limit: pageSize,
      offset,
      sortBy,
      sortDirection,
      search: searchFilter || undefined,
      teamIds: teamIdsFromUrl || undefined,
      role: roleFromUrl || undefined,
    });

  const { data: teams } = useTeams();
  const { data: roles } = useRoles();
  const { data: signupStatus } = useMemberSignupStatus();

  // Build invitation ID lookup for pending signup members
  const invitationByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of signupStatus?.pendingSignupMembers ?? []) {
      if (m.invitationId) {
        map.set(m.userId, m.invitationId);
      }
    }
    return map;
  }, [signupStatus]);

  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  // Dialog state
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [roleUpdateMember, setRoleUpdateMember] =
    useState<PaginatedMember | null>(null);
  const [removingMember, setRemovingMember] = useState<PaginatedMember | null>(
    null,
  );

  // Filter state
  const selectedTeamIds = useMemo(
    () => (teamIdsFromUrl ? teamIdsFromUrl.split(",") : []),
    [teamIdsFromUrl],
  );

  const teamItems = useMemo(
    () => (teams ?? []).map((t) => ({ value: t.id, label: t.name })),
    [teams],
  );

  const hasActiveFilters = !!(searchFilter || teamIdsFromUrl || roleFromUrl);

  // URL update helpers
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const newSorting =
        typeof updater === "function" ? updater(sorting) : updater;
      setSorting(newSorting);

      const params = new URLSearchParams(searchParams.toString());
      if (newSorting.length > 0) {
        params.set("sortBy", newSorting[0].id);
        params.set("sortDirection", newSorting[0].desc ? "desc" : "asc");
      } else {
        params.delete("sortBy");
        params.delete("sortDirection");
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [sorting, searchParams, router, pathname],
  );

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      params.set("pageSize", String(newPagination.pageSize));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const handleTeamIdsChange = useCallback(
    (values: string[]) => {
      updateUrlParams({
        teamIds: values.length > 0 ? values.join(",") : null,
      });
    },
    [updateUrlParams],
  );

  const handleRoleChange = useCallback(
    (value: string) => {
      updateUrlParams({
        role: value === "all" ? null : value,
      });
    },
    [updateUrlParams],
  );

  const handleClearFilters = useCallback(() => {
    updateUrlParams({
      search: null,
      teamIds: null,
      role: null,
    });
  }, [updateUrlParams]);

  const handleCopyInvitationLink = useCallback(
    async (member: PaginatedMember) => {
      const invitationId = invitationByUserId.get(member.userId);
      if (!invitationId) {
        toast.error("No invitation link available for this user");
        return;
      }
      const link = `${window.location.origin}/auth/sign-up-with-invitation?invitationId=${invitationId}&email=${encodeURIComponent(member.email)}`;
      await navigator.clipboard.writeText(link);
      toast.success("Invitation link copied to clipboard");
    },
    [invitationByUserId],
  );

  const members = membersResponse?.data || [];
  const pagination = membersResponse?.pagination;

  const columns: ColumnDef<PaginatedMember>[] = [
    {
      id: "name",
      accessorKey: "name",
      size: 200,
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Name
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => {
        const member = row.original;
        return (
          <div className="font-medium">
            <div className="flex items-center gap-2">
              <span className="break-words min-w-0">
                {member.name || "Unknown"}
              </span>
              {member.isPendingSignup && (
                <Badge
                  variant="outline"
                  className="text-xs text-amber-600 border-amber-500/30 bg-amber-500/10"
                >
                  Pending signup
                </Badge>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "email",
      accessorKey: "email",
      size: 250,
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Email
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => (
        <div className="text-sm text-muted-foreground">
          {row.original.email}
        </div>
      ),
    },
    {
      id: "role",
      accessorKey: "role",
      size: 120,
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Role
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => (
        <Badge variant="outline" className="text-xs">
          {toTitleCase(row.original.role)}
        </Badge>
      ),
    },
    {
      id: "teams",
      header: "Teams",
      enableSorting: false,
      cell: ({ row }) => <TeamsBadges teams={row.original.teams} />,
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      size: 160,
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Created
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({ date: row.original.createdAt })}
        </div>
      ),
    },
    ...(canManageMembers
      ? [
          {
            id: "actions",
            header: "Actions",
            size: 160,
            enableHiding: false,
            enableSorting: false,
            cell: ({ row }: { row: { original: PaginatedMember } }) => {
              const member = row.original;

              if (member.isPendingSignup) {
                const hasInvitation = invitationByUserId.has(member.userId);
                return (
                  <div className="flex items-center gap-1">
                    {hasInvitation && (
                      <TooltipButton
                        tooltip="Copy invitation link"
                        size="icon"
                        variant="ghost"
                        onClick={() => handleCopyInvitationLink(member)}
                      >
                        <Copy className="h-4 w-4" />
                      </TooltipButton>
                    )}
                    <PermissionButton
                      permissions={{ member: ["delete"] }}
                      tooltip="Remove pending user"
                      size="icon"
                      variant="ghost"
                      onClick={() => setRemovingMember(member)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </PermissionButton>
                  </div>
                );
              }

              return (
                <div className="flex items-center gap-1">
                  <PermissionButton
                    permissions={{ member: ["update"] }}
                    size="sm"
                    variant="outline"
                    onClick={() => setRoleUpdateMember(member)}
                  >
                    Update Role
                  </PermissionButton>
                  <PermissionButton
                    permissions={{ member: ["delete"] }}
                    tooltip="Remove user"
                    size="icon"
                    variant="ghost"
                    onClick={() => setRemovingMember(member)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </PermissionButton>
                </div>
              );
            },
          } satisfies ColumnDef<PaginatedMember>,
        ]
      : []),
  ];

  if (isOrgPending) {
    return <LoadingSpinner />;
  }

  if (!activeOrg) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No Organization</CardTitle>
          <CardDescription>
            You are not part of any organization yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            An organization will be created for you automatically. Please
            refresh the page or sign out and sign in again.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Invite dialog */}
      {invitationsEnabled && canInvite && (
        <Dialog
          open={inviteDialogOpen}
          onOpenChange={(open) => {
            setInviteDialogOpen(open);
            if (!open) {
              queryClient.invalidateQueries({
                queryKey: organizationKeys.invitations(),
              });
              queryClient.invalidateQueries({
                queryKey: organizationKeys.all,
              });
            }
          }}
        >
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Invite User</DialogTitle>
            </DialogHeader>
            <InviteByLinkCard
              organizationId={activeOrg.id}
              onInvitationCreated={() => setRefreshKey((prev) => prev + 1)}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Header with invite button */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Users</h3>
          <p className="text-sm text-muted-foreground">
            Manage users and their roles in your organization.
          </p>
        </div>
        {invitationsEnabled && canInvite && (
          <Button onClick={() => setInviteDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Invite User
          </Button>
        )}
      </div>

      {/* Search and filters */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-4">
          <SearchInput
            placeholder="Search by name or email..."
            paramName="search"
            className="relative max-w-md flex-1"
          />
          <MultiSelect
            value={selectedTeamIds}
            onValueChange={handleTeamIdsChange}
            items={teamItems}
            placeholder="All teams"
            className="w-[220px]"
            showSelectedBadges={false}
            selectedSuffix={(n) =>
              `${n} ${n === 1 ? "team" : "teams"} selected`
            }
          />
          <Select value={roleFromUrl ?? "all"} onValueChange={handleRoleChange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" side="bottom" align="start">
              <SelectItem value="all">All roles</SelectItem>
              {(roles ?? []).map((role) => (
                <SelectItem key={role.id} value={role.role}>
                  {toTitleCase(role.name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearFilters}
              className="h-9 px-2 text-muted-foreground"
            >
              <X className="h-4 w-4 mr-1" />
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Members DataTable */}
      <LoadingWrapper
        isPending={isMembersPending}
        loadingFallback={<LoadingSpinner />}
      >
        {members.length === 0 ? (
          <div className="text-muted-foreground">
            {searchFilter || teamIdsFromUrl || roleFromUrl
              ? "No users found matching your filters"
              : "No users found"}
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={members}
            sorting={sorting}
            onSortingChange={handleSortingChange}
            manualSorting={true}
            manualPagination={true}
            pagination={{
              pageIndex,
              pageSize,
              total: pagination?.total || 0,
            }}
            onPaginationChange={handlePaginationChange}
          />
        )}
      </LoadingWrapper>

      {/* Update Role Dialog */}
      {roleUpdateMember && activeOrg && (
        <UpdateRoleDialog
          member={roleUpdateMember}
          organizationId={activeOrg.id}
          open={!!roleUpdateMember}
          onOpenChange={(open) => !open && setRoleUpdateMember(null)}
        />
      )}

      {/* Remove Member Dialog */}
      {removingMember && activeOrg && (
        <RemoveMemberDialog
          member={removingMember}
          organizationId={activeOrg.id}
          open={!!removingMember}
          onOpenChange={(open) => !open && setRemovingMember(null)}
        />
      )}

      {/* Pending Invitations */}
      {invitationsEnabled && (
        <InvitationsList key={refreshKey} organizationId={activeOrg.id} />
      )}
    </div>
  );
}

function UpdateRoleDialog({
  member,
  organizationId,
  open,
  onOpenChange,
}: {
  member: PaginatedMember;
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [selectedRole, setSelectedRole] = useState(member.role);
  const updateMemberRole = useUpdateMemberRole();

  const handleSubmit = useCallback(async () => {
    if (selectedRole === member.role) {
      toast.info("Role is the same, no changes made");
      onOpenChange(false);
      return;
    }

    const result = await updateMemberRole.mutateAsync({
      memberId: member.id,
      role: selectedRole,
      organizationId,
    });

    if (result) {
      onOpenChange(false);
    }
  }, [selectedRole, member, organizationId, updateMemberRole, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Update Role</DialogTitle>
          <DialogDescription>
            Change the role for {member.name || member.email}.
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit}>
          <div className="py-4">
            <RoleSelect
              value={selectedRole}
              onValueChange={setSelectedRole}
              disabled={updateMemberRole.isPending}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={updateMemberRole.isPending}>
              {updateMemberRole.isPending ? "Updating..." : "Update Role"}
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

function RemoveMemberDialog({
  member,
  organizationId,
  open,
  onOpenChange,
}: {
  member: PaginatedMember;
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const removeMember = useRemoveMember();
  const deletePendingMember = useDeletePendingSignupMember();

  const isPending = removeMember.isPending || deletePendingMember.isPending;

  const handleSubmit = useCallback(async () => {
    if (member.isPendingSignup) {
      const result = await deletePendingMember.mutateAsync(member.userId);
      if (result) {
        onOpenChange(false);
      }
    } else {
      const result = await removeMember.mutateAsync({
        memberId: member.id,
        organizationId,
      });
      if (result) {
        onOpenChange(false);
      }
    }
  }, [member, organizationId, removeMember, deletePendingMember, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove User</DialogTitle>
          <DialogDescription>
            Are you sure you want to remove{" "}
            <span className="font-medium">{member.name || member.email}</span>{" "}
            from the organization? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit}>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={isPending}>
              {isPending ? "Removing..." : "Remove User"}
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

export default function MembersSettingsPage() {
  return (
    <ErrorBoundary>
      <MembersSettingsContent />
    </ErrorBoundary>
  );
}

function toTitleCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
