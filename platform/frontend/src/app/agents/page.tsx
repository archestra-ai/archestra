"use client";

import {
  createAgent,
  deleteAgent,
  type GetAgentsResponse,
  getAgents,
  updateAgent,
} from "@shared/api-client";
import { Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Agent = GetAgentsResponse[number];

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [newAgentName, setNewAgentName] = useState("");

  const fetchAgents = useCallback(async () => {
    try {
      const { data } = await getAgents();
      setAgents(data || []);
    } catch (error) {
      console.error("Failed to fetch agents:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const handleCreateAgent = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!newAgentName.trim()) return;

      try {
        await createAgent({
          body: { name: newAgentName },
        });
        await fetchAgents();
        setNewAgentName("");
      } catch (error) {
        console.error("Failed to create agent:", error);
      }
    },
    [fetchAgents, newAgentName],
  );

  const handleUpdateAgent = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!editingAgent || !editingAgent.name.trim()) return;

      try {
        await updateAgent({
          path: { id: editingAgent.id },
          body: { name: editingAgent.name },
        });
        await fetchAgents();
        setEditingAgent(null);
      } catch (error) {
        console.error("Failed to update agent:", error);
      }
    },
    [fetchAgents, editingAgent],
  );

  const handleDeleteAgent = useCallback(
    async (id: string) => {
      try {
        await deleteAgent({
          path: { id },
        });
        await fetchAgents();
      } catch (error) {
        console.error("Failed to delete agent:", error);
      }
    },
    [fetchAgents],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        Loading...
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Agents</h1>

      {/* Create New Agent Form */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Create New Agent</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreateAgent} className="flex gap-4">
            <div className="flex-1">
              <Label htmlFor="agent-name">Agent Name</Label>
              <Input
                id="agent-name"
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                placeholder="Enter agent name"
                required
              />
            </div>
            <Button type="submit" className="mt-auto">
              Create Agent
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Agents List */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Existing Agents</h2>
        {agents.length === 0 ? (
          <p className="text-muted-foreground">No agents configured</p>
        ) : (
          agents.map((agent) => (
            <Card key={agent.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                {editingAgent?.id === agent.id ? (
                  <form
                    onSubmit={handleUpdateAgent}
                    className="flex-1 flex items-center gap-2"
                  >
                    <Input
                      value={editingAgent.name}
                      onChange={(e) =>
                        setEditingAgent({
                          ...editingAgent,
                          name: e.target.value,
                        })
                      }
                      className="flex-1"
                      required
                    />
                    <Button type="submit" size="sm">
                      Save
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingAgent(null)}
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <CardTitle className="text-lg font-medium">
                      {agent.name}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditingAgent(agent)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteAgent(agent.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </>
                )}
              </CardHeader>
              {editingAgent?.id !== agent.id && (
                <CardContent>
                  <div className="text-sm text-muted-foreground">
                    <p>ID: {agent.id}</p>
                    <p>Created: {new Date(agent.createdAt).toLocaleString()}</p>
                  </div>
                </CardContent>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
