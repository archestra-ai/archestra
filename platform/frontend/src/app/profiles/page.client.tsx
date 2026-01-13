"use client";

import { archestraApiSdk, E2eTestId } from "@shared";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  DollarSign,
  ExternalLink,
  Eye,
  Lock,
  Network,
  Plus,
  Search,
  Server,
  Shield,
  Tag,
  Wrench,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import { DebouncedInput } from "@/components/debounced-input";
import { LoadingSpinner } from "@/components/loading";
import { McpConnectionInstructions } from "@/components/mcp-connection-instructions";
import { PageLayout } from "@/components/page-layout";
import { ProxyConnectionInstructions } from "@/components/proxy-connection-instructions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
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
import {
  useCreateProfile,
  useDeleteProfile,
  useLabelKeys,
  useProfilesPaginated,
  useUpdateProfile,
} from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth.query";
import {
  DEFAULT_AGENTS_PAGE_SIZE,
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  formatDate,
} from "@/lib/utils";
import { ProfileActions } from "./agent-actions";
import { AssignToolsDialog } from "./assign-tools-dialog";
// Removed ChatConfigDialog - chat configuration is now managed in /chat via Prompt Library

import type { archestraApiTypes } from "@shared";
import { PermissivePolicyBar } from "@/components/permissive-policy-bar";

type ProfilesInitialData = {
  agents: archestraApiTypes.GetAgentsResponses["200"] | null;
  teams: archestraApiTypes.GetTeamsResponses["200"];
};

export default function ProfilesPage({
  initialData,
}: {
  initialData?: ProfilesInitialData;
}) {
  return (
    <div className="w-full h-full">
      <PermissivePolicyBar />
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <Profiles initialData={initialData} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

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

function ProfileTeamsBadges({
  teams,
}: {
  teams: Array<{ id: string; name: string }> | undefined;
}) {
  const MAX_TEAMS_TO_SHOW = 3;
  if (!teams || teams.length === 0) {
    return <span className="text-sm text-muted-foreground">None</span>;
  }

  const visibleTeams = teams.slice(0, MAX_TEAMS_TO_SHOW);
  const remainingTeams = teams.slice(MAX_TEAMS_TO_SHOW);

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visibleTeams.map((team) => (
        <Badge
          key={team.id}
          variant="secondary"
          className="text-xs"
          data-testid={`${E2eTestId.ProfileTeamBadge}-${team.name}`}
        >
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

function Profiles({ initialData }: { initialData?: ProfilesInitialData }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Get pagination/filter params from URL
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const nameFilter = searchParams.get("name") || "";
  const sortByFromUrl = searchParams.get("sortBy") as
    | "name"
    | "createdAt"
    | "toolsCount"
    | "team"
    | null;
  const sortDirectionFromUrl = searchParams.get("sortDirection") as
    | "asc"
    | "desc"
    | null;

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_AGENTS_PAGE_SIZE);
  const offset = pageIndex * pageSize;

  // Default sorting
  const sortBy = sortByFromUrl || DEFAULT_SORT_BY;
  const sortDirection = sortDirectionFromUrl || DEFAULT_SORT_DIRECTION;

  const { data: agentsResponse } = useProfilesPaginated({
    initialData: initialData?.agents ?? undefined,
    limit: pageSize,
    offset,
    sortBy,
    sortDirection,
    name: nameFilter || undefined,
  });

  const agents = agentsResponse?.data || [];
  const pagination = agentsResponse?.pagination;

  const { data: _teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeams();
      return data || [];
    },
    initialData: initialData?.teams,
  });

  const [searchQuery, setSearchQuery] = useState(nameFilter);
  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  // Sync sorting state with URL params
  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [connectingProfile, setConnectingProfile] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [assigningToolsProfile, setAssigningToolsProfile] = useState<
    archestraApiTypes.GetAgentsResponses["200"]["data"][number] | null
  >(null);
  const [editingProfile, setEditingProfile] = useState<{
    id: string;
    name: string;
    teams: Array<{ id: string; name: string }>;
    labels: ProfileLabel[];
    considerContextUntrusted: boolean;
  } | null>(null);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(
    null,
  );

  type ProfileData =
    archestraApiTypes.GetAgentsResponses["200"]["data"][number];

  // Update URL when search query changes
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set("name", value);
      } else {
        params.delete("name");
      }
      params.set("page", "1"); // Reset to first page on search
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

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
      params.set("page", "1"); // Reset to first page when sorting changes
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

  const columns: ColumnDef<ProfileData>[] = [
    {
      id: "name",
      accessorKey: "name",
      size: 300,
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
        const agent = row.original;
        return (
          <div className="font-medium">
            <div className="flex items-center gap-2">
              {agent.name}
              {agent.isDefault && (
                <Badge
                  variant="outline"
                  className="bg-yellow-500/10 text-yellow-600 border-yellow-500/30 text-xs font-bold"
                >
                  DEFAULT
                </Badge>
              )}
              {agent.labels && agent.labels.length > 0 && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="inline-flex">
                        <Tag className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="flex flex-wrap gap-1 max-w-xs">
                        {agent.labels.map((label) => (
                          <Badge
                            key={label.key}
                            variant="secondary"
                            className="text-xs"
                          >
                            <span className="font-semibold">{label.key}:</span>
                            <span className="ml-1">{label.value}</span>
                          </Badge>
                        ))}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
        );
      },
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
      id: "toolsCount",
      accessorKey: "toolsCount",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Connected Tools
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => {
        const agent = row.original;
        return (
          <div className="flex items-center gap-2">
            {row.original.tools.length}
            <PermissionButton
              permissions={{ profile: ["update"] }}
              tooltip="Assign Tools"
              aria-label="Assign Tools"
              variant="outline"
              size="icon-sm"
              onClick={() => setAssigningToolsProfile(agent)}
            >
              <Wrench className="h-4 w-4" />
            </PermissionButton>
          </div>
        );
      },
    },
    {
      id: "team",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Teams
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => (
        <ProfileTeamsBadges
          teams={
            row.original.teams as unknown as Array<{
              id: string;
              name: string;
            }>
          }
        />
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 176,
      enableHiding: false,
      cell: ({ row }) => {
        const agent = row.original;
        return (
          <ProfileActions
            agent={agent}
            onConnect={setConnectingProfile}
            onEdit={(agentData) => {
              setEditingProfile({
                id: agentData.id,
                name: agentData.name,
                teams:
                  (agentData.teams as unknown as Array<{
                    id: string;
                    name: string;
                  }>) || [],
                labels: agentData.labels || [],
                considerContextUntrusted: agentData.considerContextUntrusted,
              });
            }}
            onDelete={setDeletingProfileId}
          />
        );
      },
    },
  ];

  return (
    <PageLayout
      title="Profiles"
      description={
        <p className="text-sm text-muted-foreground">
          Profiles organize access, MCP tools, cost limits, and observability
          for N8N workflows, custom applications, or teams sharing an MCP
          gateway.{" "}
          <a
            href="https://archestra.ai/docs/platform-agents"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            Read more in the docs
          </a>
        </p>
      }
      actionButton={
        <PermissionButton
          permissions={{ profile: ["create"] }}
          onClick={() => setIsCreateDialogOpen(true)}
          data-testid={E2eTestId.CreateAgentButton}
        >
          <Plus className="mr-2 h-4 w-4" />
          Create Profile
        </PermissionButton>
      }
    >
      <div>
        <div>
          <div className="mb-6">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <DebouncedInput
                placeholder="Search profiles by name..."
                initialValue={searchQuery}
                onChange={handleSearchChange}
                className="pl-9"
              />
            </div>
          </div>

          {!agents || agents.length === 0 ? (
            <div className="text-muted-foreground">
              {nameFilter
                ? "No profiles found matching your search"
                : "No profiles found"}
            </div>
          ) : (
            <div data-testid={E2eTestId.AgentsTable}>
              <DataTable
                columns={columns}
                data={agents}
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
            </div>
          )}

          <CreateProfileDialog
            open={isCreateDialogOpen}
            onOpenChange={setIsCreateDialogOpen}
            onProfileCreated={(profile) => {
              setIsCreateDialogOpen(false);
              setConnectingProfile(profile);
            }}
          />

          {connectingProfile && (
            <ConnectProfileDialog
              agent={connectingProfile}
              open={!!connectingProfile}
              onOpenChange={(open) => !open && setConnectingProfile(null)}
            />
          )}

          {assigningToolsProfile && (
            <AssignToolsDialog
              agent={assigningToolsProfile}
              open={!!assigningToolsProfile}
              onOpenChange={(open) => !open && setAssigningToolsProfile(null)}
            />
          )}

          {/* Removed ChatConfigDialog - chat configuration is now managed in /chat via Prompt Library */}

          {editingProfile && (
            <EditProfileDialog
              agent={editingProfile}
              open={!!editingProfile}
              onOpenChange={(open) => !open && setEditingProfile(null)}
            />
          )}

          {deletingProfileId && (
            <DeleteProfileDialog
              agentId={deletingProfileId}
              open={!!deletingProfileId}
              onOpenChange={(open) => !open && setDeletingProfileId(null)}
            />
          )}
        </div>
      </div>
    </PageLayout>
  );
}

function CreateProfileDialog({
  open,
  onOpenChange,
  onProfileCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProfileCreated?: (profile: { id: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [assignedTeamIds, setAssignedTeamIds] = useState<string[]>([]);
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const [considerContextUntrusted, setConsiderContextUntrusted] =
    useState(false);
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const response = await archestraApiSdk.getTeams();
      return response.data || [];
    },
  });
  const { data: availableKeys = [] } = useLabelKeys();
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const createProfile = useCreateProfile();
  const agentLabelsRef = useRef<ProfileLabelsRef>(null);
  const { data: isProfileAdmin } = useHasPermissions({ profile: ["admin"] });

  // Non-admin users must select at least one team
  const requiresTeamSelection = !isProfileAdmin && assignedTeamIds.length === 0;
  const hasNoAvailableTeams = !teams || teams.length === 0;

  const handleAddTeam = useCallback(
    (teamId: string) => {
      if (teamId && !assignedTeamIds.includes(teamId)) {
        setAssignedTeamIds([...assignedTeamIds, teamId]);
        setSelectedTeamId("");
      }
    },
    [assignedTeamIds],
  );

  const handleRemoveTeam = useCallback(
    (teamId: string) => {
      setAssignedTeamIds(assignedTeamIds.filter((id) => id !== teamId));
    },
    [assignedTeamIds],
  );

  const getUnassignedTeams = useCallback(() => {
    if (!teams) return [];
    return teams.filter((team) => !assignedTeamIds.includes(team.id));
  }, [teams, assignedTeamIds]);

  const getTeamById = useCallback(
    (teamId: string) => {
      return teams?.find((team) => team.id === teamId);
    },
    [teams],
  );

  const handleClose = useCallback(() => {
    setName("");
    setAssignedTeamIds([]);
    setLabels([]);
    setSelectedTeamId("");
    setConsiderContextUntrusted(false);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim()) {
        toast.error("Please enter a profile name");
        return;
      }

      // Non-admin users must select at least one team
      if (!isProfileAdmin && assignedTeamIds.length === 0) {
        toast.error("Please select at least one team");
        return;
      }

      // Save any unsaved label before submitting
      const updatedLabels =
        agentLabelsRef.current?.saveUnsavedLabel() || labels;

      try {
        const agent = await createProfile.mutateAsync({
          name: name.trim(),
          teams: assignedTeamIds,
          labels: updatedLabels,
          considerContextUntrusted,
        });
        if (!agent) {
          throw new Error("Failed to create profile");
        }
        toast.success("Profile created successfully");
        if (onProfileCreated) {
          onProfileCreated({ id: agent.id, name: agent.name });
        } else {
          handleClose();
        }
      } catch (_error) {
        toast.error("Failed to create profile");
      }
    },
    [
      name,
      assignedTeamIds,
      labels,
      considerContextUntrusted,
      createProfile,
      isProfileAdmin,
      onProfileCreated,
      handleClose,
    ],
  );

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-4xl max-h-[90vh] flex flex-col"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Create new profile</DialogTitle>
          <DialogDescription>
            Create a new profile to use with the Archestra Platform proxy.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col flex-1 overflow-hidden"
        >
          <div className="grid gap-4 overflow-y-auto pr-2 pb-4 space-y-2">
            <div className="grid gap-2">
              <Label htmlFor="name">Profile Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My AI Profile"
                autoFocus
              />
            </div>

            <div className="grid gap-2">
              <Label>
                Team Access
                {!isProfileAdmin && (
                  <span className="text-destructive ml-1">(required)</span>
                )}
              </Label>
              <p className="text-sm text-muted-foreground">
                Assign teams to grant their members access to this profile.
              </p>
              <Select value={selectedTeamId} onValueChange={handleAddTeam}>
                <SelectTrigger id="assign-team">
                  <SelectValue placeholder="Select a team to assign" />
                </SelectTrigger>
                <SelectContent>
                  {teams?.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      No teams available
                    </div>
                  ) : getUnassignedTeams().length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      All teams are already assigned
                    </div>
                  ) : (
                    getUnassignedTeams().map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {assignedTeamIds.length > 0 ? (
                <div className="flex flex-wrap gap-2 mt-2">
                  {assignedTeamIds.map((teamId) => {
                    const team = getTeamById(teamId);
                    return (
                      <Badge
                        key={teamId}
                        variant="secondary"
                        className="flex items-center gap-1 pr-1"
                      >
                        <span>{team?.name || teamId}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveTeam(teamId)}
                          className="ml-1 hover:bg-destructive/20 rounded-full p-0.5"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {isProfileAdmin
                    ? "No teams assigned yet. Admins have access to all profiles."
                    : hasNoAvailableTeams
                      ? "You are not a member of any team. Contact an admin to be added to a team."
                      : "No teams assigned yet."}
                </p>
              )}
            </div>

            <ProfileLabels
              ref={agentLabelsRef}
              labels={labels}
              onLabelsChange={setLabels}
              availableKeys={availableKeys}
            />

            <div className="flex items-center space-x-2">
              <Checkbox
                id="consider-context-untrusted"
                checked={considerContextUntrusted}
                onCheckedChange={(checked) =>
                  setConsiderContextUntrusted(checked === true)
                }
              />
              <div className="grid gap-1">
                <Label
                  htmlFor="consider-context-untrusted"
                  className="text-sm font-medium cursor-pointer"
                >
                  Treat user context as untrusted
                </Label>
                <p className="text-sm text-muted-foreground">
                  Enable when user prompts may contain untrusted and sensitive
                  data.
                </p>
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                createProfile.isPending ||
                requiresTeamSelection ||
                (!isProfileAdmin && hasNoAvailableTeams)
              }
            >
              {createProfile.isPending ? "Creating..." : "Create profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditProfileDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: {
    id: string;
    name: string;
    teams: Array<{ id: string; name: string }>;
    labels: ProfileLabel[];
    considerContextUntrusted: boolean;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(agent.name);
  const [assignedTeamIds, setAssignedTeamIds] = useState<string[]>(
    agent.teams?.map((t) => t.id) || [],
  );
  const [labels, setLabels] = useState<ProfileLabel[]>(agent.labels || []);
  const [considerContextUntrusted, setConsiderContextUntrusted] = useState(
    agent.considerContextUntrusted,
  );
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const response = await archestraApiSdk.getTeams();
      return response.data || [];
    },
  });
  const { data: availableKeys = [] } = useLabelKeys();
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const updateProfile = useUpdateProfile();
  const agentLabelsRef = useRef<ProfileLabelsRef>(null);
  const { data: isProfileAdmin } = useHasPermissions({ profile: ["admin"] });

  // Non-admin users must have at least one team assigned
  const requiresTeamSelection = !isProfileAdmin && assignedTeamIds.length === 0;

  const handleAddTeam = useCallback(
    (teamId: string) => {
      if (teamId && !assignedTeamIds.includes(teamId)) {
        setAssignedTeamIds([...assignedTeamIds, teamId]);
        setSelectedTeamId("");
      }
    },
    [assignedTeamIds],
  );

  const handleRemoveTeam = useCallback(
    (teamId: string) => {
      setAssignedTeamIds(assignedTeamIds.filter((id) => id !== teamId));
    },
    [assignedTeamIds],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim()) {
        toast.error("Please enter a profile name");
        return;
      }

      // Non-admin users must have at least one team assigned
      if (!isProfileAdmin && assignedTeamIds.length === 0) {
        toast.error("Please select at least one team");
        return;
      }

      // Save any unsaved label before submitting
      const updatedLabels =
        agentLabelsRef.current?.saveUnsavedLabel() || labels;

      try {
        await updateProfile.mutateAsync({
          id: agent.id,
          data: {
            name: name.trim(),
            teams: assignedTeamIds,
            labels: updatedLabels,
            considerContextUntrusted,
          },
        });
        toast.success("Profile updated successfully");
        onOpenChange(false);
      } catch (_error) {
        toast.error("Failed to update profile");
      }
    },
    [
      agent.id,
      name,
      assignedTeamIds,
      labels,
      updateProfile,
      onOpenChange,
      considerContextUntrusted,
      isProfileAdmin,
    ],
  );

  const getUnassignedTeams = useCallback(() => {
    if (!teams) return [];
    return teams.filter((team) => !assignedTeamIds.includes(team.id));
  }, [teams, assignedTeamIds]);

  const getTeamById = useCallback(
    (teamId: string) => {
      return teams?.find((team) => team.id === teamId);
    },
    [teams],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] flex flex-col"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
          <DialogDescription>
            Update the profile's name and assign teams.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col flex-1 overflow-hidden"
        >
          <div className="grid gap-4 overflow-y-auto pr-2 pb-4 space-y-2">
            <div className="grid gap-2">
              <Label htmlFor="edit-name">Profile Name</Label>
              <Input
                id="edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My AI Profile"
                autoFocus
              />
            </div>

            <div className="grid gap-2">
              <Label>
                Team Access
                {!isProfileAdmin && (
                  <span className="text-destructive ml-1">(required)</span>
                )}
              </Label>
              <p className="text-sm text-muted-foreground">
                Assign teams to grant their members access to this profile.
              </p>
              <Select value={selectedTeamId} onValueChange={handleAddTeam}>
                <SelectTrigger id="assign-team">
                  <SelectValue placeholder="Select a team to assign" />
                </SelectTrigger>
                <SelectContent>
                  {teams?.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      No teams available
                    </div>
                  ) : getUnassignedTeams().length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      All teams are already assigned
                    </div>
                  ) : (
                    getUnassignedTeams().map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {assignedTeamIds.length > 0 ? (
                <div className="flex flex-wrap gap-2 mt-2">
                  {assignedTeamIds.map((teamId) => {
                    const team = getTeamById(teamId);
                    return (
                      <Badge
                        key={teamId}
                        variant="secondary"
                        className="flex items-center gap-1 pr-1"
                      >
                        <span>{team?.name || teamId}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveTeam(teamId)}
                          data-testid={`${E2eTestId.RemoveTeamBadge}-${team?.name || teamId}`}
                          className="ml-1 hover:bg-destructive/20 rounded-full p-0.5"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {isProfileAdmin
                    ? "No teams assigned yet. Admins have access to all profiles."
                    : "No teams assigned yet."}
                </p>
              )}
            </div>

            <ProfileLabels
              ref={agentLabelsRef}
              labels={labels}
              onLabelsChange={setLabels}
              availableKeys={availableKeys}
            />

            <div className="flex items-center space-x-2">
              <Checkbox
                id="edit-consider-context-untrusted"
                checked={considerContextUntrusted}
                onCheckedChange={(checked) =>
                  setConsiderContextUntrusted(checked === true)
                }
              />
              <div className="grid gap-1">
                <Label
                  htmlFor="edit-consider-context-untrusted"
                  className="text-sm font-medium cursor-pointer"
                >
                  Treat user context as untrusted
                </Label>
                <p className="text-sm text-muted-foreground">
                  Enable when user prompts may contain untrusted and sensitive
                  data.
                </p>
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={updateProfile.isPending || requiresTeamSelection}
            >
              {updateProfile.isPending ? "Updating..." : "Update profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProfileConnectionColumns({ agentId }: { agentId: string }) {
  const [activeTab, setActiveTab] = useState<"proxy" | "mcp">("proxy");

  return (
    <div className="space-y-6">
      {/* Tab Selection with inline features */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => setActiveTab("proxy")}
          className={`flex-1 flex flex-col gap-2 p-3 rounded-lg transition-all duration-200 ${
            activeTab === "proxy"
              ? "bg-blue-500/5 border-2 border-blue-500/30"
              : "bg-muted/30 border-2 border-transparent hover:bg-muted/50"
          }`}
        >
          <div className="flex items-center gap-2">
            <Network
              className={`h-4 w-4 ${activeTab === "proxy" ? "text-blue-500" : ""}`}
            />
            <span className="font-medium">LLM Proxy</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Lock className="h-2.5 w-2.5 text-blue-600 dark:text-blue-400" />
              <span className="text-[10px]">Security</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Eye className="h-2.5 w-2.5 text-purple-600 dark:text-purple-400" />
              <span className="text-[10px]">Observability</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <DollarSign className="h-2.5 w-2.5 text-green-600 dark:text-green-400" />
              <span className="text-[10px]">Cost</span>
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("mcp")}
          className={`flex-1 flex flex-col gap-2 p-3 rounded-lg transition-all duration-200 ${
            activeTab === "mcp"
              ? "bg-green-500/5 border-2 border-green-500/30"
              : "bg-muted/30 border-2 border-transparent hover:bg-muted/50"
          }`}
        >
          <div className="flex items-center gap-2">
            <Shield
              className={`h-4 w-4 ${activeTab === "mcp" ? "text-green-500" : ""}`}
            />
            <span className="font-medium">MCP Gateway</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Server className="h-2.5 w-2.5 text-green-600 dark:text-green-400" />
              <span className="text-[10px]">Unified MCP</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Eye className="h-2.5 w-2.5 text-purple-600 dark:text-purple-400" />
              <span className="text-[10px]">Observability</span>
            </div>
          </div>
        </button>
      </div>

      {/* Content */}
      <div className="relative">
        {activeTab === "proxy" ? (
          <div className="animate-in fade-in-0 slide-in-from-left-2 duration-300">
            <div className="p-4 rounded-lg border bg-card">
              <ProxyConnectionInstructions agentId={agentId} />
            </div>
          </div>
        ) : (
          <div className="animate-in fade-in-0 slide-in-from-right-2 duration-300">
            <div className="p-4 rounded-lg border bg-card">
              <McpConnectionInstructions agentId={agentId} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectProfileDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] p-0 flex flex-col border-0">
        {/* Header with gradient */}
        <div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-background px-6 pt-6 pb-5 shrink-0">
          <div className="absolute inset-0 bg-grid-white/[0.02] pointer-events-none" />
          <div className="relative">
            <DialogHeader>
              <div className="flex items-center gap-2 mb-1">
                <div className="p-1.5 rounded-full bg-primary/10">
                  <Network className="h-4 w-4 text-primary" />
                </div>
                <DialogTitle className="text-xl font-semibold">
                  Connect via "{agent.name}"
                </DialogTitle>
              </div>
            </DialogHeader>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <ProfileConnectionColumns agentId={agent.id} />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t bg-muted/30 shrink-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ExternalLink className="h-3.5 w-3.5" />
            <span>Need help? Check our</span>
            <a
              href="https://archestra.ai/docs/platform-profiles"
              target="_blank"
              className="text-primary hover:underline font-medium"
              rel="noopener"
            >
              documentation
            </a>
          </div>
          <Button
            type="button"
            onClick={() => onOpenChange(false)}
            size="default"
            className="min-w-[100px]"
          >
            Done
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProfileDialog({
  agentId,
  open,
  onOpenChange,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteProfile = useDeleteProfile();

  const handleDelete = useCallback(async () => {
    try {
      await deleteProfile.mutateAsync(agentId);
      toast.success("Profile deleted successfully");
      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to delete profile");
    }
  }, [agentId, deleteProfile, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delete profile</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this profile? This action cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteProfile.isPending}
          >
            {deleteProfile.isPending ? "Deleting..." : "Delete profile"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
