"use client";

import { archestraApiSdk, E2eTestId } from "@shared";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronUp,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Search,
  Tag,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import {
  type AgentLabel,
  AgentLabels,
  type AgentLabelsRef,
} from "@/components/agent-labels";
import { LoadingSpinner } from "@/components/loading";
import { McpConnectionInstructions } from "@/components/mcp-connection-instructions";
import { ProxyConnectionInstructions } from "@/components/proxy-connection-instructions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useAgentsPaginated,
  useCreateAgent,
  useDeleteAgent,
  useLabelKeys,
  useUpdateAgent,
} from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth.query";
import { formatDate } from "@/lib/utils";
import { AssignToolsDialog } from "./assign-tools-dialog";
import { ChatConfigDialog } from "./chat-config-dialog";

export default function AgentsPage() {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <Agents />
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

function AgentTeamsBadges({
  teamIds,
  teams,
}: {
  teamIds: string[];
  teams:
    | Array<{ id: string; name: string; description: string | null }>
    | undefined;
}) {
  const MAX_TEAMS_TO_SHOW = 3;
  if (!teams || teamIds.length === 0) {
    return <span className="text-sm text-muted-foreground">None</span>;
  }

  const getTeamById = (teamId: string) => {
    return teams.find((team) => team.id === teamId);
  };

  const visibleTeams = teamIds.slice(0, MAX_TEAMS_TO_SHOW);
  const remainingTeams = teamIds.slice(MAX_TEAMS_TO_SHOW);

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visibleTeams.map((teamId) => {
        const team = getTeamById(teamId);
        return (
          <Badge key={teamId} variant="secondary" className="text-xs">
            {team?.name || teamId}
          </Badge>
        );
      })}
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
                {remainingTeams.map((teamId) => {
                  const team = getTeamById(teamId);
                  return (
                    <div key={teamId} className="text-xs">
                      {team?.name || teamId}
                    </div>
                  );
                })}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

function Agents() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const { data: userCanCreateAgents } = useHasPermissions({
    agent: ["create"],
  });
  const { data: userCanDeleteAgents } = useHasPermissions({
    agent: ["delete"],
  });

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
  const pageSize = Number(pageSizeFromUrl || "20");
  const offset = pageIndex * pageSize;

  // Default sorting
  const sortBy = sortByFromUrl || "createdAt";
  const sortDirection = sortDirectionFromUrl || "desc";

  const { data: agentsResponse } = useAgentsPaginated({
    limit: pageSize,
    offset,
    sortBy,
    sortDirection,
    name: nameFilter || undefined,
  });

  const agents = agentsResponse?.data || [];
  const pagination = agentsResponse?.pagination;

  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeams();
      return data || [];
    },
  });

  const [searchQuery, setSearchQuery] = useState(nameFilter);
  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  // Sync sorting state with URL params
  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  // Debounce search query updates to URL
  useEffect(() => {
    // Only run if search query differs from URL
    const currentNameParam = searchParams.get("name") || "";
    if (searchQuery === currentNameParam) {
      return;
    }

    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (searchQuery) {
        params.set("name", searchQuery);
      } else {
        params.delete("name");
      }
      params.set("page", "1"); // Reset to first page on search
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    }, 500); // 500ms debounce

    return () => clearTimeout(timer);
  }, [searchQuery, searchParams, router, pathname]);

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [connectingAgent, setConnectingAgent] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [assigningToolsAgent, setAssigningToolsAgent] = useState<
    (typeof agents)[number] | null
  >(null);
  const [chatConfigAgent, setChatConfigAgent] = useState<
    (typeof agents)[number] | null
  >(null);
  const [editingAgent, setEditingAgent] = useState<{
    id: string;
    name: string;
    teams: string[];
    labels: AgentLabel[];
  } | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);

  type AgentData = (typeof agents)[number];

  // Update local search state only - URL update is debounced in useEffect
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
  }, []);

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

  const columns: ColumnDef<AgentData>[] = [
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
      cell: ({ row }) => <div>{row.original.tools.length}</div>,
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
        <AgentTeamsBadges teamIds={row.original.teams || []} teams={teams} />
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 100,
      cell: ({ row }) => {
        const agent = row.original;
        return (
          <div className="flex items-center gap-0 border rounded-md overflow-hidden w-fit">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConnectingAgent({
                        id: agent.id,
                        name: agent.name,
                      });
                    }}
                    className="rounded-none border-r h-8 w-8"
                  >
                    <Plug className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Connect</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="More Options"
                  onClick={(e) => e.stopPropagation()}
                  className="rounded-none h-8 w-8"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setAssigningToolsAgent(agent);
                    }}
                  >
                    <Wrench className="h-4 w-4" />
                    Assign Tools
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setChatConfigAgent(agent);
                    }}
                  >
                    <MessageCircle className="h-4 w-4" />
                    Configure Chat
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingAgent({
                        id: agent.id,
                        name: agent.name,
                        teams: agent.teams || [],
                        labels: agent.labels || [],
                      });
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                {userCanDeleteAgents && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        variant="destructive"
                        data-testid={`${E2eTestId.DeleteAgentButton}-${agent.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeletingAgentId(agent.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  return (
    <div className="w-full h-full">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight mb-2">
                Agents
              </h1>
              <p className="text-sm text-muted-foreground">
                Agents are a way to organize access and logging. <br />
                <br />
                An agent can be: an N8N workflow, a custom application, or a
                team sharing an MCP gateway.{" "}
                <a
                  href="https://www.archestra.ai/docs/platform-agents"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                >
                  Read more in the docs
                </a>
              </p>
            </div>
            {userCanCreateAgents && (
              <Button
                onClick={() => setIsCreateDialogOpen(true)}
                data-testid={E2eTestId.CreateAgentButton}
              >
                <Plus className="mr-2 h-4 w-4" />
                Create Agent
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
        {agents.length > 0 ? (
          <div className="mb-6">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search agents by name..."
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
        ) : null}

        {!agents || agents.length === 0 ? (
          <div className="text-muted-foreground">
            {nameFilter
              ? "No agents found matching your search"
              : "No agents found"}
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

        <CreateAgentDialog
          open={isCreateDialogOpen}
          onOpenChange={setIsCreateDialogOpen}
        />

        {connectingAgent && (
          <ConnectAgentDialog
            agent={connectingAgent}
            open={!!connectingAgent}
            onOpenChange={(open) => !open && setConnectingAgent(null)}
          />
        )}

        {assigningToolsAgent && (
          <AssignToolsDialog
            agent={assigningToolsAgent}
            open={!!assigningToolsAgent}
            onOpenChange={(open) => !open && setAssigningToolsAgent(null)}
          />
        )}

        {chatConfigAgent && (
          <ChatConfigDialog
            agent={chatConfigAgent}
            open={!!chatConfigAgent}
            onOpenChange={(open) => !open && setChatConfigAgent(null)}
          />
        )}

        {editingAgent && (
          <EditAgentDialog
            agent={editingAgent}
            open={!!editingAgent}
            onOpenChange={(open) => !open && setEditingAgent(null)}
          />
        )}

        {deletingAgentId && (
          <DeleteAgentDialog
            agentId={deletingAgentId}
            open={!!deletingAgentId}
            onOpenChange={(open) => !open && setDeletingAgentId(null)}
          />
        )}
      </div>
    </div>
  );
}

function CreateAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [assignedTeamIds, setAssignedTeamIds] = useState<string[]>([]);
  const [labels, setLabels] = useState<AgentLabel[]>([]);
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const response = await archestraApiSdk.getTeams();
      return response.data || [];
    },
  });
  const { data: availableKeys = [] } = useLabelKeys();
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [createdAgent, setCreatedAgent] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const createAgent = useCreateAgent();
  const agentLabelsRef = useRef<AgentLabelsRef>(null);

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

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim()) {
        toast.error("Please enter an agent name");
        return;
      }

      // Save any unsaved label before submitting
      const updatedLabels =
        agentLabelsRef.current?.saveUnsavedLabel() || labels;

      try {
        const agent = await createAgent.mutateAsync({
          name: name.trim(),
          teams: assignedTeamIds,
          labels: updatedLabels,
        });
        if (!agent) {
          throw new Error("Failed to create agent");
        }
        toast.success("Agent created successfully");
        setCreatedAgent({ id: agent.id, name: agent.name });
      } catch (_error) {
        toast.error("Failed to create agent");
      }
    },
    [name, assignedTeamIds, labels, createAgent],
  );

  const handleClose = useCallback(() => {
    setName("");
    setAssignedTeamIds([]);
    setLabels([]);
    setSelectedTeamId("");
    setCreatedAgent(null);
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-4xl max-h-[90vh] flex flex-col"
        onInteractOutside={(e) => e.preventDefault()}
      >
        {!createdAgent ? (
          <>
            <DialogHeader>
              <DialogTitle>Create new agent</DialogTitle>
              <DialogDescription>
                Create a new agent to use with the Archestra Platform proxy.
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={handleSubmit}
              className="flex flex-col flex-1 overflow-hidden"
            >
              <div className="grid gap-4 overflow-y-auto pr-2 pb-4 space-y-2">
                <div className="grid gap-2">
                  <Label htmlFor="name">Agent Name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My AI Agent"
                    autoFocus
                  />
                </div>

                <div className="grid gap-2">
                  <Label>Team Access</Label>
                  <p className="text-sm text-muted-foreground">
                    Assign teams to grant their members access to this agent.
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
                      No teams assigned yet. Admins have access to all agents.
                    </p>
                  )}
                </div>

                <AgentLabels
                  ref={agentLabelsRef}
                  labels={labels}
                  onLabelsChange={setLabels}
                  availableKeys={availableKeys}
                />
              </div>
              <DialogFooter className="mt-4">
                <Button type="button" variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createAgent.isPending}>
                  {createAgent.isPending ? "Creating..." : "Create agent"}
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                How to connect "{createdAgent.name}" to Archestra
              </DialogTitle>
            </DialogHeader>
            <div className="overflow-y-auto py-4 flex-1">
              <AgentConnectionTabs agentId={createdAgent.id} />
            </div>
            <DialogFooter className="shrink-0">
              <Button
                type="button"
                onClick={handleClose}
                data-testid={E2eTestId.CreateAgentCloseHowToConnectButton}
              >
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditAgentDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: {
    id: string;
    name: string;
    teams: string[];
    labels: AgentLabel[];
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(agent.name);
  const [assignedTeamIds, setAssignedTeamIds] = useState<string[]>(
    agent.teams || [],
  );
  const [labels, setLabels] = useState<AgentLabel[]>(agent.labels || []);
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const response = await archestraApiSdk.getTeams();
      return response.data || [];
    },
  });
  const { data: availableKeys = [] } = useLabelKeys();
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const updateAgent = useUpdateAgent();
  const agentLabelsRef = useRef<AgentLabelsRef>(null);

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
        toast.error("Please enter an agent name");
        return;
      }

      // Save any unsaved label before submitting
      const updatedLabels =
        agentLabelsRef.current?.saveUnsavedLabel() || labels;

      try {
        await updateAgent.mutateAsync({
          id: agent.id,
          data: {
            name: name.trim(),
            teams: assignedTeamIds,
            labels: updatedLabels,
          },
        });
        toast.success("Agent updated successfully");
        onOpenChange(false);
      } catch (_error) {
        toast.error("Failed to update agent");
      }
    },
    [agent.id, name, assignedTeamIds, labels, updateAgent, onOpenChange],
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
          <DialogTitle>Edit agent</DialogTitle>
          <DialogDescription>
            Update the agent's name and assign teams.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col flex-1 overflow-hidden"
        >
          <div className="grid gap-4 overflow-y-auto pr-2 pb-4 space-y-2">
            <div className="grid gap-2">
              <Label htmlFor="edit-name">Agent Name</Label>
              <Input
                id="edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My AI Agent"
                autoFocus
              />
            </div>

            <div className="grid gap-2">
              <Label>Team Access</Label>
              <p className="text-sm text-muted-foreground">
                Assign teams to grant their members access to this agent.
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
                  No teams assigned yet. Admins have access to all agents.
                </p>
              )}
            </div>

            <AgentLabels
              ref={agentLabelsRef}
              labels={labels}
              onLabelsChange={setLabels}
              availableKeys={availableKeys}
            />
          </div>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={updateAgent.isPending}>
              {updateAgent.isPending ? "Updating..." : "Update agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentConnectionTabs({ agentId }: { agentId: string }) {
  return (
    <div className="grid grid-cols-2 gap-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2 pb-2 border-b">
          <h3 className="font-medium">LLM Proxy</h3>
          <h4 className="text-sm text-muted-foreground">
            For security, observibility and enabling tools
          </h4>
        </div>
        <ProxyConnectionInstructions agentId={agentId} />
      </div>
      <div className="space-y-3">
        <div className="flex items-center gap-2 pb-2 border-b">
          <h3 className="font-medium">MCP Gateway</h3>
          <h4 className="text-sm text-muted-foreground">
            To enable tools for the agent
          </h4>
        </div>
        <McpConnectionInstructions agentId={agentId} />
      </div>
    </div>
  );
}

function ConnectAgentDialog({
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
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>How to connect "{agent.name}" to Archestra</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <AgentConnectionTabs agentId={agent.id} />
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteAgentDialog({
  agentId,
  open,
  onOpenChange,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteAgent = useDeleteAgent();

  const handleDelete = useCallback(async () => {
    try {
      await deleteAgent.mutateAsync(agentId);
      toast.success("Agent deleted successfully");
      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to delete agent");
    }
  }, [agentId, deleteAgent, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delete agent</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this agent? This action cannot be
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
            disabled={deleteAgent.isPending}
          >
            {deleteAgent.isPending ? "Deleting..." : "Delete agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
