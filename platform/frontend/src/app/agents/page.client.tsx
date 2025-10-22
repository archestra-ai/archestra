"use client";

import { E2eTestId } from "@shared";
import {
  MoreVertical,
  Pencil,
  Plug,
  Plus,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Suspense, useCallback, useMemo, useState } from "react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { useCurrentOrgMembers } from "@/lib/auth.query";
import type { GetAgentsResponses } from "@/lib/clients/api";
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

function AgentMembersBadges({
  usersWithAccess,
  orgMembers,
}: {
  usersWithAccess: string[];
  orgMembers:
    | Array<{ user: { id: string; name: string; email: string } }>
    | undefined;
}) {
  const MAX_USERS_TO_SHOW = 3;
  if (!orgMembers || usersWithAccess.length === 0) {
    return <span className="text-sm text-muted-foreground">None</span>;
  }

  const getUserById = (userId: string) => {
    return orgMembers.find((member) => member.user.id === userId)?.user;
  };

  const visibleUsers = usersWithAccess.slice(0, MAX_USERS_TO_SHOW);
  const remainingUsers = usersWithAccess.slice(MAX_USERS_TO_SHOW);

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visibleUsers.map((userId) => {
        const user = getUserById(userId);
        return (
          <Badge key={userId} variant="secondary" className="text-xs">
            {user?.email || userId}
          </Badge>
        );
      })}
      {remainingUsers.length > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground cursor-help">
                +{remainingUsers.length} more
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="flex flex-col gap-1">
                {remainingUsers.map((userId) => {
                  const user = getUserById(userId);
                  return (
                    <div key={userId} className="text-xs">
                      {user?.email || userId}
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
  const { data: orgMembers } = useCurrentOrgMembers();
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
    usersWithAccess: string[];
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
                    <TableHead>Members</TableHead>
                    <WithPermission permissions={["agent:delete"]}>
                      <TableHead className="text-right">Actions</TableHead>
                    </WithPermission>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map((agent) => (
                    <TableRow key={agent.id}>
                      <TableCell className="font-medium">
                        {agent.name}
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
                        <AgentMembersBadges
                          usersWithAccess={agent.usersWithAccess || []}
                          orgMembers={orgMembers}
                        />
                      </TableCell>
                      <WithPermission permissions={["agent:delete"]}>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                data-testid={`${E2eTestId.AgentActionsDropdownTrigger}-${agent.name}`}
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() =>
                                  setConnectingAgent({
                                    id: agent.id,
                                    name: agent.name,
                                  })
                                }
                              >
                                <Plug className="h-4 w-4" />
                                Connect
                              </DropdownMenuItem>
                              {mcpRegistryEnabled && (
                                <DropdownMenuItem
                                  onClick={() => setAssigningToolsAgent(agent)}
                                >
                                  <Wrench className="h-4 w-4" />
                                  Assign Tools
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() =>
                                  setEditingAgent({
                                    id: agent.id,
                                    name: agent.name,
                                    usersWithAccess:
                                      agent.usersWithAccess || [],
                                  })
                                }
                              >
                                <Pencil className="h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                data-testid={`${E2eTestId.DeleteAgentButton}-${agent.name}`}
                                onClick={() => setDeletingAgentId(agent.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
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
  const [assignedUserIds, setAssignedUserIds] = useState<string[]>([]);
  const { data: orgMembers } = useCurrentOrgMembers();
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [createdAgent, setCreatedAgent] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const createAgent = useCreateAgent();

  const handleAddUser = useCallback(
    (userId: string) => {
      if (userId && !assignedUserIds.includes(userId)) {
        setAssignedUserIds([...assignedUserIds, userId]);
        setSelectedUserId("");
      }
    },
    [assignedUserIds],
  );

  const handleRemoveUser = useCallback(
    (userId: string) => {
      setAssignedUserIds(assignedUserIds.filter((id) => id !== userId));
    },
    [assignedUserIds],
  );

  const getAdminMembers = useCallback(() => {
    if (!orgMembers) return [];
    return orgMembers.filter((member) => member.role === "admin");
  }, [orgMembers]);

  const getUnassignedMembers = useCallback(() => {
    if (!orgMembers) return [];
    return orgMembers.filter(
      (member) =>
        member.role !== "admin" && !assignedUserIds.includes(member.user.id),
    );
  }, [orgMembers, assignedUserIds]);

  const getUserById = useCallback(
    (userId: string) => {
      return orgMembers?.find((member) => member.user.id === userId)?.user;
    },
    [orgMembers],
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
          usersWithAccess: assignedUserIds,
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
    [name, assignedUserIds, createAgent],
  );

  const handleClose = useCallback(() => {
    setName("");
    setAssignedUserIds([]);
    setSelectedUserId("");
    setCreatedAgent(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const adminMemberIds = useMemo(() => {
    return getAdminMembers().map((member) => member.user.id);
  }, [getAdminMembers]);

  /**
   * NOTE: this is a bit of a quick hack to not show admin members in the assigned users list
   * (since they have access to all agents and right now the backend returns ids for ALL users that have access)
   */
  const filteredAssignedUserIds = useMemo(() => {
    return assignedUserIds.filter((userId) => !adminMemberIds.includes(userId));
  }, [assignedUserIds, adminMemberIds]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] flex flex-col"
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
                  <Label>Members with access</Label>
                  <p className="text-sm text-muted-foreground">
                    Admin users have access to all agents.
                  </p>
                  <Select value={selectedUserId} onValueChange={handleAddUser}>
                    <SelectTrigger id="assign-user">
                      <SelectValue placeholder="Select a member to assign" />
                    </SelectTrigger>
                    <SelectContent>
                      {getUnassignedMembers().length === 0 ? (
                        <div className="px-2 py-1.5 text-sm text-muted-foreground">
                          All members are already assigned
                        </div>
                      ) : (
                        getUnassignedMembers().map((member) => (
                          <SelectItem
                            key={member.user.id}
                            value={member.user.id}
                          >
                            {member.user.name} ({member.user.email})
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  {getAdminMembers().length > 0 ||
                  filteredAssignedUserIds.length > 0 ? (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {getAdminMembers().map((member) => (
                        <Badge
                          key={member.user.id}
                          variant="outline"
                          className="flex items-center gap-1 bg-blue-300/10 text-blue-300"
                        >
                          <span>{member.user.email} (Admin)</span>
                        </Badge>
                      ))}
                      {filteredAssignedUserIds.map((userId) => {
                        const user = getUserById(userId);
                        return (
                          <Badge
                            key={userId}
                            variant="secondary"
                            className="flex items-center gap-1 pr-1"
                          >
                            <span>{user?.email || userId}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveUser(userId)}
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
                      No members assigned yet
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
              <DialogTitle>How to connect to {createdAgent.name}</DialogTitle>
              <DialogDescription>
                Connect your agent via LLM Proxy (for conversations) or MCP
                Gateway (for tool access).
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <AgentConnectionTabs agentId={createdAgent.id} />
            </div>
            <DialogFooter>
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
  agent: { id: string; name: string; usersWithAccess: string[] };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(agent.name);
  const [assignedUserIds, setAssignedUserIds] = useState<string[]>(
    agent.usersWithAccess || [],
  );
  const { data: orgMembers } = useCurrentOrgMembers();
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const updateAgent = useUpdateAgent();

  const handleAddUser = useCallback(
    (userId: string) => {
      if (userId && !assignedUserIds.includes(userId)) {
        setAssignedUserIds([...assignedUserIds, userId]);
        setSelectedUserId("");
      }
    },
    [assignedUserIds],
  );

  const handleRemoveUser = useCallback(
    (userId: string) => {
      setAssignedUserIds(assignedUserIds.filter((id) => id !== userId));
    },
    [assignedUserIds],
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
            usersWithAccess: assignedUserIds,
          },
        });
        toast.success("Agent updated successfully");
        onOpenChange(false);
      } catch (_error) {
        toast.error("Failed to update agent");
      }
    },
    [agent.id, name, assignedUserIds, updateAgent, onOpenChange],
  );

  const getAdminMembers = useCallback(() => {
    if (!orgMembers) return [];
    return orgMembers.filter((member) => member.role === "admin");
  }, [orgMembers]);

  const getUnassignedMembers = useCallback(() => {
    if (!orgMembers) return [];
    return orgMembers.filter(
      (member) =>
        member.role !== "admin" && !assignedUserIds.includes(member.user.id),
    );
  }, [orgMembers, assignedUserIds]);

  const getUserById = useCallback(
    (userId: string) => {
      return orgMembers?.find((member) => member.user.id === userId)?.user;
    },
    [orgMembers],
  );

  const adminMemberIds = useMemo(() => {
    return getAdminMembers().map((member) => member.user.id);
  }, [getAdminMembers]);

  /**
   * NOTE: this is a bit of a quick hack to not show admin members in the assigned users list
   * (since they have access to all agents and right now the backend returns ids for ALL users that have access)
   */
  const filteredAssignedUserIds = useMemo(() => {
    return assignedUserIds.filter((userId) => !adminMemberIds.includes(userId));
  }, [assignedUserIds, adminMemberIds]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] flex flex-col"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Edit agent</DialogTitle>
          <DialogDescription>
            Update the agent's name and assign organization members.
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
              <Label>Members with access</Label>
              <p className="text-sm text-muted-foreground">
                Admin users have access to all agents.
              </p>
              <Select value={selectedUserId} onValueChange={handleAddUser}>
                <SelectTrigger id="assign-user">
                  <SelectValue placeholder="Select a member to assign" />
                </SelectTrigger>
                <SelectContent>
                  {getUnassignedMembers().length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      All members are already assigned
                    </div>
                  ) : (
                    getUnassignedMembers().map((member) => (
                      <SelectItem key={member.user.id} value={member.user.id}>
                        {member.user.name} ({member.user.email})
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {getAdminMembers().length > 0 ||
              filteredAssignedUserIds.length > 0 ? (
                <div className="flex flex-wrap gap-2 mt-2">
                  {getAdminMembers().map((member) => (
                    <Badge
                      key={member.user.id}
                      variant="outline"
                      className="flex items-center gap-1 bg-blue-300/10 text-blue-300"
                    >
                      <span>{member.user.email} (Admin)</span>
                    </Badge>
                  ))}
                  {filteredAssignedUserIds.map((userId) => {
                    const user = getUserById(userId);
                    return (
                      <Badge
                        key={userId}
                        variant="secondary"
                        className="flex items-center gap-1 pr-1"
                      >
                        <span>{user?.email || userId}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveUser(userId)}
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
                  No members assigned yet
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
    <Tabs defaultValue="llm-proxy" className="w-full">
      <TabsList>
        <TabsTrigger value="llm-proxy">LLM Proxy</TabsTrigger>
        <TabsTrigger value="mcp-gateway">MCP Gateway</TabsTrigger>
      </TabsList>
      <TabsContent value="llm-proxy" className="mt-4">
        <ProxyConnectionInstructions agentId={agentId} />
      </TabsContent>
      <TabsContent value="mcp-gateway" className="mt-4">
        <McpConnectionInstructions agentId={agentId} />
      </TabsContent>
    </Tabs>
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>How to connect to {agent.name}</DialogTitle>
          <DialogDescription>
            Connect your agent via LLM Proxy (for conversations) or MCP Gateway
            (for tool access).
          </DialogDescription>
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
