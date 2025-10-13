"use client";

import { E2eTestId } from "@shared";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
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
                  href="https://www.archestra.ai/docs/"
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
                    <TableHead>Agent ID</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map((agent) => (
                    <TableRow key={agent.id}>
                      <TableCell className="font-medium">
                        {agent.name}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {agent.id}
                      </TableCell>
                      <TableCell>
                        {new Date(agent.createdAt).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "numeric",
                          day: "numeric",
                        })}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              setEditingAgent({
                                id: agent.id,
                                name: agent.name,
                              })
                            }
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            data-testid={`${E2eTestId.DeleteAgentButton}-${agent.name}`}
                            onClick={() => setDeletingAgentId(agent.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
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
  const createAgent = useCreateAgent();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Please enter an agent name");
      return;
    }

    try {
      await createAgent.mutateAsync({ name: name.trim() });
      toast.success("Agent created successfully");
      setName("");
      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to create agent");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Agent</DialogTitle>
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
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createAgent.isPending}>
              {createAgent.isPending ? "Creating..." : "Create Agent"}
            </Button>
          </DialogFooter>
        </form>
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

  const handleSubmit = async (e: React.FormEvent) => {
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
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Agent</DialogTitle>
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
              {updateAgent.isPending ? "Updating..." : "Update Agent"}
            </Button>
          </DialogFooter>
        </form>
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

  const handleDelete = async () => {
    try {
      await deleteAgent.mutateAsync(agentId);
      toast.success("Agent deleted successfully");
      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to delete agent");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Agent</DialogTitle>
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
            {deleteAgent.isPending ? "Deleting..." : "Delete Agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
