"use client";

import { E2eTestId } from "@shared";
import { MoreVertical, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { Suspense, useCallback, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { ProxyConnectionInstructions } from "@/components/proxy-connection-instructions";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useAgents,
  useCreateAgent,
  useDeleteAgent,
  useUpdateAgent,
} from "@/lib/agent.query";
import type { GetAgentsResponses } from "@/lib/clients/api";

export default function AgentsPage({
  initialData,
}: {
  initialData: GetAgentsResponses["200"];
}) {
  return (
    <div className="container mx-auto overflow-y-auto">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <Agents initialData={initialData} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function Agents({ initialData }: { initialData: GetAgentsResponses["200"] }) {
  const { data: agents } = useAgents({ initialData });
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [connectingAgent, setConnectingAgent] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [editingAgent, setEditingAgent] = useState<{
    id: string;
    name: string;
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
            <Button
              onClick={() => setIsCreateDialogOpen(true)}
              data-testid={E2eTestId.CreateAgentButton}
            >
              <Plus className="mr-2 h-4 w-4" />
              Create Agent
            </Button>
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
                    <TableHead className="text-right">Actions</TableHead>
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
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
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
                            <DropdownMenuItem
                              onClick={() =>
                                setEditingAgent({
                                  id: agent.id,
                                  name: agent.name,
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
  const [createdAgent, setCreatedAgent] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const createAgent = useCreateAgent();

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim()) {
        toast.error("Please enter an agent name");
        return;
      }

      try {
        const agent = await createAgent.mutateAsync({ name: name.trim() });
        if (!agent) {
          throw new Error("Failed to create agent");
        }
        toast.success("Agent created successfully");
        setCreatedAgent({ id: agent.id, name: agent.name });
      } catch (_error) {
        toast.error("Failed to create agent");
      }
    },
    [name, createAgent],
  );

  const handleClose = useCallback(() => {
    setName("");
    setCreatedAgent(null);
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        {!createdAgent ? (
          <>
            <DialogHeader>
              <DialogTitle>Create new agent</DialogTitle>
              <DialogDescription>
                Create a new agent to use with the Archestra Platform proxy.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit}>
              <div className="grid gap-4 py-4">
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
              </div>
              <DialogFooter>
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
              <DialogTitle>How to connect</DialogTitle>
              <DialogDescription>
                Use this proxy URL to connect {createdAgent.name} to Archestra
                Platform.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <ProxyConnectionInstructions agentId={createdAgent.id} />
            </div>
            <DialogFooter>
              <Button type="button" onClick={handleClose}>
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
  agent: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(agent.name);
  const updateAgent = useUpdateAgent();

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
          data: { name: name.trim() },
        });
        toast.success("Agent updated successfully");
        onOpenChange(false);
      } catch (_error) {
        toast.error("Failed to update agent");
      }
    },
    [agent.id, name, updateAgent, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit agent</DialogTitle>
          <DialogDescription>Update the agent's name.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
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
          </div>
          <DialogFooter>
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
          <DialogTitle>How to connect</DialogTitle>
          <DialogDescription>
            Use this proxy URL to connect {agent.name} to the Archestra
            Platform.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <ProxyConnectionInstructions agentId={agent.id} />
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
