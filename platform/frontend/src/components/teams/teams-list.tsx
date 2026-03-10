"use client";
import { archestraApiSdk, E2eTestId } from "@shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronUp,
  Key,
  Link2,
  Plus,
  Settings,
  Trash2,
  Users,
  Vault,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { lazy, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import config from "@/lib/config";
import { useFeature } from "@/lib/config.query";
import { type Team, useTeamsPaginated } from "@/lib/team.query";
import { type TeamToken, useTokens } from "@/lib/team-token.query";
import {
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_TABLE_LIMIT,
  formatDate,
} from "@/lib/utils";
import { TeamMembersDialog } from "./team-members-dialog";
import { TokenManagerDialog } from "./token-manager-dialog";

const TeamVaultFolderDialog = lazy(
  () =>
    // biome-ignore lint/style/noRestrictedImports: lazy loading
    import("./team-vault-folder-dialog.ee"),
);

const { TeamExternalGroupsDialog } = config.enterpriseFeatures.core
  ? // biome-ignore lint/style/noRestrictedImports: conditional EE component with SSO / external teams
    await import("./team-external-groups-dialog.ee")
  : {
      TeamExternalGroupsDialog: () => null,
    };

export function TeamsList() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const byosEnabled = useFeature("byosEnabled");

  // Dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [membersDialogOpen, setMembersDialogOpen] = useState(false);
  const [externalGroupsDialogOpen, setExternalGroupsDialogOpen] =
    useState(false);
  const [vaultFolderDialogOpen, setVaultFolderDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [teamToDelete, setTeamToDelete] = useState<Team | null>(null);

  // Token management state
  const [selectedToken, setSelectedToken] = useState<TeamToken | null>(null);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);

  // Form state
  const [teamName, setTeamName] = useState("");
  const [teamDescription, setTeamDescription] = useState("");

  // Tokens query
  const { data: tokensData, isLoading: tokensLoading } = useTokens();
  const tokens = tokensData?.tokens;

  // URL search params for pagination/sorting
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const searchFilter = searchParams.get("search") || "";
  const sortByFromUrl = searchParams.get("sortBy") as
    | "name"
    | "createdAt"
    | "memberCount"
    | null;
  const sortDirectionFromUrl = searchParams.get("sortDirection") as
    | "asc"
    | "desc"
    | null;

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);
  const offset = pageIndex * pageSize;
  const sortBy = sortByFromUrl || DEFAULT_SORT_BY;
  const sortDirection = sortDirectionFromUrl || DEFAULT_SORT_DIRECTION;

  const { data: teamsResponse } = useTeamsPaginated({
    limit: pageSize,
    offset,
    sortBy,
    sortDirection,
    search: searchFilter || undefined,
  });

  const teams = teamsResponse?.data || [];
  const pagination = teamsResponse?.pagination;

  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  // Sync sorting state with URL params
  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  // Update URL when sorting changes
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

  // Update URL when pagination changes
  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      params.set("pageSize", String(newPagination.pageSize));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  // Mutations
  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description?: string }) => {
      return await archestraApiSdk.createTeam({
        body: data,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      setCreateDialogOpen(false);
      setTeamName("");
      setTeamDescription("");
      toast.success("Team created successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to create team");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (teamId: string) => {
      return await archestraApiSdk.deleteTeam({
        path: { id: teamId },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      setDeleteDialogOpen(false);
      setTeamToDelete(null);
      toast.success("Team deleted successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to delete team");
    },
  });

  const handleCreateTeam = () => {
    if (!teamName.trim()) {
      toast.error("Team name is required");
      return;
    }

    createMutation.mutate({
      name: teamName,
      description: teamDescription || undefined,
    });
  };

  const handleDeleteTeam = () => {
    if (teamToDelete) {
      deleteMutation.mutate(teamToDelete.id);
    }
  };

  const columns: ColumnDef<Team>[] = [
    {
      id: "name",
      accessorKey: "name",
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
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.name}</div>
          {row.original.description && (
            <div className="text-sm text-muted-foreground">
              {row.original.description}
            </div>
          )}
        </div>
      ),
    },
    {
      id: "memberCount",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Members
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => row.original.members?.length || 0,
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
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
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => (
        <TeamActions
          team={row.original}
          tokens={tokens}
          tokensLoading={tokensLoading}
          byosEnabled={byosEnabled}
          onManageToken={(token) => {
            setSelectedToken(token);
            setTokenDialogOpen(true);
          }}
          onManageMembers={(team) => {
            setSelectedTeam(team);
            setMembersDialogOpen(true);
          }}
          onConfigureVault={(team) => {
            setSelectedTeam(team);
            setVaultFolderDialogOpen(true);
          }}
          onConfigureSsoSync={(team) => {
            setSelectedTeam(team);
            setExternalGroupsDialogOpen(true);
          }}
          onDelete={(team) => {
            setTeamToDelete(team);
            setDeleteDialogOpen(true);
          }}
        />
      ),
    },
  ];

  return (
    <>
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
        <SearchInput
          placeholder="Search teams..."
          paramName="search"
          className="relative max-w-md flex-1"
        />
        <PermissionButton
          permissions={{ team: ["create"] }}
          onClick={() => setCreateDialogOpen(true)}
          className="shrink-0 self-start md:self-auto"
        >
          <Plus className="mr-2 h-4 w-4" />
          Create Team
        </PermissionButton>
      </div>

      {!teams || teams.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Users className="mb-4 h-12 w-12 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {searchFilter
              ? "No teams found matching your search"
              : "There are no teams you have access to"}
          </p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={teams}
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

      {/* Create Team Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Create New Team</DialogTitle>
            <DialogDescription>
              Create a team to organize access to profiles and MCP servers
            </DialogDescription>
          </DialogHeader>
          <DialogForm onSubmit={handleCreateTeam}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="name">Team Name *</Label>
                <Input
                  id="name"
                  placeholder="Engineering Team"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  placeholder="Team for engineering staff..."
                  value={teamDescription}
                  onChange={(e) => setTeamDescription(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create Team"}
              </Button>
            </DialogFooter>
          </DialogForm>
        </DialogContent>
      </Dialog>

      {/* Delete Team Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Delete Team</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{teamToDelete?.name}"? This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogForm onSubmit={handleDeleteTeam}>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting..." : "Delete"}
              </Button>
            </DialogFooter>
          </DialogForm>
        </DialogContent>
      </Dialog>

      {selectedTeam && (
        <>
          <TeamMembersDialog
            open={membersDialogOpen}
            onOpenChange={setMembersDialogOpen}
            team={selectedTeam}
          />
          <TeamExternalGroupsDialog
            open={externalGroupsDialogOpen}
            onOpenChange={setExternalGroupsDialogOpen}
            team={selectedTeam}
          />
          <TeamVaultFolderDialog
            open={vaultFolderDialogOpen}
            onOpenChange={setVaultFolderDialogOpen}
            team={selectedTeam}
          />
        </>
      )}

      {selectedToken && (
        <TokenManagerDialog
          open={tokenDialogOpen}
          onOpenChange={setTokenDialogOpen}
          token={selectedToken}
        />
      )}
    </>
  );
}

// ===  Private components ===

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

function TeamActions({
  team,
  tokens,
  tokensLoading,
  byosEnabled,
  onManageToken,
  onManageMembers,
  onConfigureVault,
  onConfigureSsoSync,
  onDelete,
}: {
  team: Team;
  tokens: TeamToken[] | undefined;
  tokensLoading: boolean;
  byosEnabled: boolean | undefined;
  onManageToken: (token: TeamToken) => void;
  onManageMembers: (team: Team) => void;
  onConfigureVault: (team: Team) => void;
  onConfigureSsoSync: (team: Team) => void;
  onDelete: (team: Team) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 shrink-0">
      <PermissionButton
        permissions={{ team: ["update"] }}
        variant="outline"
        size="sm"
        disabled={tokensLoading}
        onClick={() => {
          const teamToken = tokens?.find((t) => t.team?.id === team.id);
          if (teamToken) {
            onManageToken(teamToken);
          } else {
            toast.error("No token found for this team");
          }
        }}
      >
        <Key className="mr-2 h-4 w-4" />
        Manage Token
      </PermissionButton>
      <PermissionButton
        permissions={{ team: ["update"] }}
        variant="outline"
        size="sm"
        onClick={() => onManageMembers(team)}
        data-testid={`${E2eTestId.ManageMembersButton}-${team.name}`}
      >
        <Settings className="mr-2 h-4 w-4" />
        Manage Members
      </PermissionButton>
      {byosEnabled && (
        <Tooltip>
          <TooltipTrigger asChild>
            <PermissionButton
              permissions={{ team: ["update"] }}
              variant="outline"
              size="sm"
              data-testid={`${E2eTestId.ConfigureVaultFolderButton}-${team.name}`}
              onClick={() => onConfigureVault(team)}
            >
              <Vault className="h-4 w-4" />
            </PermissionButton>
          </TooltipTrigger>
          <TooltipContent>Configure Vault Folder</TooltipContent>
        </Tooltip>
      )}
      {config.enterpriseFeatures.core && (
        <Tooltip>
          <TooltipTrigger asChild>
            <PermissionButton
              permissions={{ team: ["update"] }}
              variant="outline"
              size="sm"
              data-testid={`${E2eTestId.ConfigureIdpTeamSyncButton}-${team.id}`}
              onClick={() => onConfigureSsoSync(team)}
            >
              <Link2 className="h-4 w-4" />
            </PermissionButton>
          </TooltipTrigger>
          <TooltipContent>Configure SSO Team Sync</TooltipContent>
        </Tooltip>
      )}
      <PermissionButton
        permissions={{ team: ["delete"] }}
        variant="outline"
        size="sm"
        onClick={() => onDelete(team)}
      >
        <Trash2 className="h-4 w-4 text-destructive" />
      </PermissionButton>
    </div>
  );
}
