"use client";

import { E2eTestId } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Plug, Plus, Trash2, Wrench, X } from "lucide-react";
import { Suspense, useCallback, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { McpConnectionInstructions } from "@/components/mcp-connection-instructions";
import { ProxyConnectionInstructions } from "@/components/proxy-connection-instructions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WithPermission } from "@/components/with-permission";
import {
  useAgents,
  useCreateAgent,
  useDeleteAgent,
  useUpdateAgent,
} from "@/lib/agent.query";
import type { GetAgentsResponses } from "@/lib/clients/api";
import { getTeams } from "@/lib/clients/api/sdk.gen";
import { useFeatureFlag } from "@/lib/features.hook";
import { AssignToolsDialog } from "./assign-tools-dialog";

export default function AgentsPage({
  initialData,
}: {
  initialData: GetAgentsResponses["200"];
}) {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <Agents initialData={initialData} />
        </Suspense>
      </ErrorBoundary>
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

function Agents({ initialData }: { initialData: GetAgentsResponses["200"] }) {
  const { data: agents } = useAgents({ initialData });
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await getTeams();
      return data || [];
    },
  });
  const mcpRegistryEnabled = useFeatureFlag("mcp_registry");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [connectingAgent, setConnectingAgent] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [assigningToolsAgent, setAssigningToolsAgent] = useState<
    GetAgentsResponses["200"][number] | null
  >(null);
  const [editingAgent, setEditingAgent] = useState<{
    id: string;
    name: string;
    teams: string[];
  } | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);

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
                List of agents detected by proxy.{" "}
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
            <WithPermission permissions={["agent:create"]}>
              <Button
                onClick={() => setIsCreateDialogOpen(true)}
                data-testid={E2eTestId.CreateAgentButton}
              >
                <Plus className="mr-2 h-4 w-4" />
                Create Agent
              </Button>
            </WithPermission>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        {!agents || agents.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No agents found</CardTitle>
              <CardDescription>
                Create your first agent to get started with the Archestra
                Platform.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <Card>
            <CardContent className="px-6">
              <Table data-testid={E2eTestId.AgentsTable}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Connected Tools</TableHead>
                    <TableHead>Teams</TableHead>
                    <WithPermission permissions={["agent:delete"]}>
                      <TableHead className="text-right">Actions</TableHead>
                    </WithPermission>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map((agent) => (
                    <TableRow key={agent.id}>
                      <TableCell className="font-medium">
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
                        </div>
                      </TableCell>
                      <TableCell>
                        {new Date(agent.createdAt).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "numeric",
                          day: "numeric",
                        })}
                      </TableCell>
                      <TableCell>{agent.tools.length}</TableCell>
                      <TableCell>
                        <AgentTeamsBadges
                          teamIds={agent.teams || []}
                          teams={teams}
                        />
                      </TableCell>
                      <WithPermission permissions={["agent:delete"]}>
                        <TableCell>
                          <div className="flex items-center gap-1 justify-end">
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() =>
                                      setConnectingAgent({
                                        id: agent.id,
                                        name: agent.name,
                                      })
                                    }
                                  >
                                    <Plug className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Connect</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            {mcpRegistryEnabled && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() =>
                                        setAssigningToolsAgent(agent)
                                      }
                                    >
                                      <Wrench className="h-4 w-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Assign Tools</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() =>
                                      setEditingAgent({
                                        id: agent.id,
                                        name: agent.name,
                                        teams: agent.teams || [],
                                      })
                                    }
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Edit</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    data-testid={`${E2eTestId.DeleteAgentButton}-${agent.name}`}
                                    onClick={() => setDeletingAgentId(agent.id)}
                                    className="hover:bg-destructive/10 hover:text-destructive"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Delete</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                        </TableCell>
                      </WithPermission>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
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
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const response = await getTeams();
      return response.data || [];
    },
  });
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [createdAgent, setCreatedAgent] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const createAgent = useCreateAgent();

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

      try {
        const agent = await createAgent.mutateAsync({
          name: name.trim(),
          teams: assignedTeamIds,
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
    [name, assignedTeamIds, createAgent],
  );

  const handleClose = useCallback(() => {
    setName("");
    setAssignedTeamIds([]);
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
                      {getUnassignedTeams().length === 0 ? (
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
  agent: { id: string; name: string; teams: string[] };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(agent.name);
  const [assignedTeamIds, setAssignedTeamIds] = useState<string[]>(
    agent.teams || [],
  );
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const response = await getTeams();
      return response.data || [];
    },
  });
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const updateAgent = useUpdateAgent();

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

      try {
        await updateAgent.mutateAsync({
          id: agent.id,
          data: {
            name: name.trim(),
            teams: assignedTeamIds,
          },
        });
        toast.success("Agent updated successfully");
        onOpenChange(false);
      } catch (_error) {
        toast.error("Failed to update agent");
      }
    },
    [agent.id, name, assignedTeamIds, updateAgent, onOpenChange],
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
                  {getUnassignedTeams().length === 0 ? (
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
