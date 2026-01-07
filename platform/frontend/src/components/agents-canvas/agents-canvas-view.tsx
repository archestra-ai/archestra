"use client";

import type { archestraApiTypes } from "@shared";
import {
  addEdge,
  Background,
  type Connection,
  Controls,
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Search, X } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { A2AConnectionInstructions } from "@/components/a2a-connection-instructions";
import { PromptDialog } from "@/components/chat/prompt-dialog";
import { PromptVersionHistoryDialog } from "@/components/chat/prompt-version-history-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProfiles } from "@/lib/agent.query";
import {
  promptAgentsQueryKeys,
  useAllPromptAgentConnections,
  useSyncPromptAgents,
} from "@/lib/prompt-agents.query";
import { useDeletePrompt, usePrompt, usePrompts } from "@/lib/prompts.query";
import { AgentNode, type AgentNodeData } from "./agent-node";
import { AgentNodeContext } from "./agent-node-context";
import { DeletableEdge } from "./deletable-edge";
import { resolveCollisions } from "./resolve-collisions";
import { useLayoutNodes } from "./use-layout-nodes";

type Prompt = archestraApiTypes.GetPromptsResponses["200"][number];

const nodeTypes = { agent: AgentNode };
const edgeTypes = { deletable: DeletableEdge };

const POSITIONS_STORAGE_KEY = "agents-canvas-positions";

type SavedPositions = Record<string, { x: number; y: number }>;

function loadSavedPositions(): SavedPositions {
  if (typeof window === "undefined") return {};
  try {
    const saved = localStorage.getItem(POSITIONS_STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

function savePositions(nodes: Node<AgentNodeData>[]) {
  if (typeof window === "undefined") return;
  const positions: SavedPositions = {};
  for (const node of nodes) {
    positions[node.id] = { x: node.position.x, y: node.position.y };
  }
  localStorage.setItem(POSITIONS_STORAGE_KEY, JSON.stringify(positions));
}

function AgentsCanvasViewInner() {
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const reactFlowInstance = useReactFlow();
  const { getLayoutedNodes } = useLayoutNodes();
  const { data: prompts = [], isLoading: isLoadingPrompts } = usePrompts();
  const { data: profiles = [] } = useProfiles();
  const { data: connections = [], isLoading: isLoadingConnections } =
    useAllPromptAgentConnections();
  const syncPromptAgents = useSyncPromptAgents();

  const isLoading = isLoadingPrompts || isLoadingConnections;
  const [isLayoutReady, setIsLayoutReady] = useState(false);
  const [isAutoLayouting, setIsAutoLayouting] = useState(false);

  // Dialog state
  const [isPromptDialogOpen, setIsPromptDialogOpen] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [deletingPromptId, setDeletingPromptId] = useState<string | null>(null);
  const [connectingPrompt, setConnectingPrompt] = useState<Prompt | null>(null);
  const [versionHistoryPrompt, setVersionHistoryPrompt] =
    useState<Prompt | null>(null);

  const { data: editingPrompt } = usePrompt(editingPromptId || "");
  const deletePromptMutation = useDeletePrompt();

  const handleEditAgent = useCallback((promptId: string) => {
    setEditingPromptId(promptId);
    setIsPromptDialogOpen(true);
  }, []);

  const handleDeleteAgent = useCallback((promptId: string) => {
    setDeletingPromptId(promptId);
  }, []);

  const handleConnectAgent = useCallback(
    (promptId: string) => {
      const prompt = prompts.find((p) => p.id === promptId);
      if (prompt) {
        setConnectingPrompt(prompt);
      }
    },
    [prompts],
  );

  const confirmDelete = useCallback(() => {
    if (deletingPromptId) {
      deletePromptMutation.mutate(deletingPromptId);
      setDeletingPromptId(null);
    }
  }, [deletingPromptId, deletePromptMutation]);

  const contextValue = useMemo(
    () => ({
      onEditAgent: handleEditAgent,
      onDeleteAgent: handleDeleteAgent,
      onConnectAgent: handleConnectAgent,
    }),
    [handleEditAgent, handleDeleteAgent, handleConnectAgent],
  );

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string>("all");

  // Track previous data for change detection
  const prevPromptsRef = useRef<typeof prompts>([]);
  const initialLoadDone = useRef(false);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AgentNodeData>>(
    [],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Filter nodes visually (dim non-matching)
  const displayNodes = useMemo(() => {
    const hasSearch = searchQuery.trim().length > 0;
    const hasProfileFilter = selectedProfileId !== "all";

    if (!hasSearch && !hasProfileFilter) return nodes;

    const query = searchQuery.toLowerCase();

    // Find directly matching agents
    const directMatchIds = new Set(
      prompts
        .filter((prompt) => {
          const matchesSearch =
            !hasSearch || prompt.name.toLowerCase().includes(query);
          const matchesProfile =
            !hasProfileFilter || prompt.agentId === selectedProfileId;
          return matchesSearch && matchesProfile;
        })
        .map((p) => p.id),
    );

    // Also include children of matching agents (recursive)
    const matchingIds = new Set(directMatchIds);
    const addChildren = (parentId: string) => {
      for (const conn of connections) {
        if (
          conn.promptId === parentId &&
          !matchingIds.has(conn.agentPromptId)
        ) {
          matchingIds.add(conn.agentPromptId);
          addChildren(conn.agentPromptId); // Recursively add grandchildren
        }
      }
    };
    for (const id of directMatchIds) {
      addChildren(id);
    }

    return nodes.map((node) => ({
      ...node,
      style: matchingIds.has(node.id)
        ? undefined
        : { opacity: 0.2, pointerEvents: "none" as const },
    }));
  }, [nodes, searchQuery, selectedProfileId, prompts, connections]);

  // Save positions whenever nodes change (after initial load)
  useEffect(() => {
    if (isLayoutReady && nodes.length > 0 && initialLoadDone.current) {
      savePositions(nodes);
    }
  }, [nodes, isLayoutReady]);

  // Load nodes with saved positions or apply auto-layout for new nodes
  useEffect(() => {
    if (isLoading || prompts.length === 0) {
      return;
    }

    const prevPromptIds = new Set(prevPromptsRef.current.map((p) => p.id));
    const currentPromptIds = new Set(prompts.map((p) => p.id));
    const newPromptIds = prompts
      .filter((p) => !prevPromptIds.has(p.id))
      .map((p) => p.id);

    const promptsChanged =
      JSON.stringify([...currentPromptIds].sort()) !==
      JSON.stringify([...prevPromptIds].sort());

    if (!promptsChanged && isLayoutReady) {
      return;
    }

    const savedPositions = loadSavedPositions();

    // Create edges
    const initialEdges: Edge[] = connections.map((conn) => ({
      id: `${conn.promptId}-${conn.agentPromptId}`,
      source: conn.promptId,
      target: conn.agentPromptId,
      sourceHandle: "tools",
      type: "deletable",
      animated: true,
      style: { strokeWidth: 2 },
    }));

    // Check if this is a new agent being added (not initial load)
    const isNewAgentAdded =
      initialLoadDone.current && newPromptIds.length > 0 && isLayoutReady;

    if (isNewAgentAdded) {
      // Position new agent to the right of the rightmost existing node
      setNodes((currentNodes) => {
        // Find the rightmost position among existing nodes
        let maxX = 0;
        let topY = 0;
        for (const node of currentNodes) {
          const nodeRight = node.position.x + 180; // node width
          if (nodeRight > maxX) {
            maxX = nodeRight;
            topY = node.position.y;
          }
        }

        // Position new nodes to the right with some margin
        const startX = maxX + 100;
        const newNodes: Node<AgentNodeData>[] = [];

        for (let i = 0; i < newPromptIds.length; i++) {
          const promptId = newPromptIds[i];
          const prompt = prompts.find((p) => p.id === promptId);
          if (prompt) {
            newNodes.push({
              id: prompt.id,
              type: "agent" as const,
              position: {
                x: startX,
                y: topY + i * 100,
              },
              data: { label: prompt.name, promptId: prompt.id },
            });
          }
        }

        const merged = [...currentNodes, ...newNodes];
        // Resolve collisions for the new layout
        const changes = resolveCollisions(merged, {
          margin: 20,
          maxIterations: 10,
        });
        if (changes.length > 0) {
          return merged.map((node) => {
            const change = changes.find(
              (c) => c.type === "position" && c.id === node.id,
            );
            if (change && change.type === "position" && change.position) {
              return { ...node, position: change.position };
            }
            return node;
          });
        }
        return merged;
      });
      setEdges(initialEdges);
      prevPromptsRef.current = prompts;
      return;
    }

    const hasAllPositions = prompts.every((p) => savedPositions[p.id]);

    if (hasAllPositions) {
      // Use saved positions
      const nodesWithPositions: Node<AgentNodeData>[] = prompts.map(
        (prompt) => ({
          id: prompt.id,
          type: "agent" as const,
          position: savedPositions[prompt.id],
          data: { label: prompt.name, promptId: prompt.id },
        }),
      );
      setNodes(nodesWithPositions);
      setEdges(initialEdges);
      setIsLayoutReady(true);
      prevPromptsRef.current = prompts;
      initialLoadDone.current = true;
      setTimeout(
        () =>
          reactFlowInstance.fitView({
            padding: 0.1,
            minZoom: 0.1,
            maxZoom: 1.5,
          }),
        50,
      );
    } else {
      // Apply auto-layout for new/missing nodes
      const initialNodes: Node<AgentNodeData>[] = prompts.map((prompt) => ({
        id: prompt.id,
        type: "agent" as const,
        position: savedPositions[prompt.id] ?? { x: 0, y: 0 },
        data: { label: prompt.name, promptId: prompt.id },
      }));

      getLayoutedNodes(initialNodes, initialEdges).then((layoutedNodes) => {
        setNodes(layoutedNodes);
        setEdges(initialEdges);
        setIsLayoutReady(true);
        prevPromptsRef.current = prompts;
        initialLoadDone.current = true;
        setTimeout(
          () =>
            reactFlowInstance.fitView({
              padding: 0.1,
              minZoom: 0.1,
              maxZoom: 1.5,
            }),
          50,
        );
      });
    }
  }, [
    prompts,
    connections,
    isLoading,
    isLayoutReady,
    getLayoutedNodes,
    setNodes,
    setEdges,
    reactFlowInstance,
  ]);

  // Manual auto-layout button handler
  const handleAutoLayout = useCallback(async () => {
    if (nodes.length === 0) return;
    setIsAutoLayouting(true);

    try {
      const layoutedNodes = await getLayoutedNodes(nodes, edges);

      // Resolve any remaining collisions
      const changes = resolveCollisions(layoutedNodes, {
        margin: 20,
        maxIterations: 15,
      });

      const finalNodes =
        changes.length > 0
          ? layoutedNodes.map((node) => {
              const change = changes.find(
                (c) => c.type === "position" && c.id === node.id,
              );
              if (change && change.type === "position" && change.position) {
                return { ...node, position: change.position };
              }
              return node;
            })
          : layoutedNodes;

      setNodes(finalNodes);
      setTimeout(
        () =>
          reactFlowInstance.fitView({
            padding: 0.1,
            minZoom: 0.1,
            maxZoom: 1.5,
          }),
        50,
      );
    } finally {
      setIsAutoLayouting(false);
    }
  }, [nodes, edges, getLayoutedNodes, setNodes, reactFlowInstance]);

  // Handle node drag stop - resolve collisions
  const onNodeDragStop = useCallback(() => {
    const changes = resolveCollisions(nodes, {
      margin: 20,
      maxIterations: 10,
    });
    if (changes.length > 0) {
      setNodes((currentNodes) =>
        currentNodes.map((node) => {
          const change = changes.find(
            (c) => c.type === "position" && c.id === node.id,
          );
          if (change && change.type === "position" && change.position) {
            return { ...node, position: change.position };
          }
          return node;
        }),
      );
    }
  }, [nodes, setNodes]);

  // Get current connections for a source node
  const getExistingConnections = useCallback(
    (sourceId: string) => {
      return connections
        .filter((conn) => conn.promptId === sourceId)
        .map((conn) => conn.agentPromptId);
    },
    [connections],
  );

  // Handle new connection
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;

      // Prevent self-connection
      if (connection.source === connection.target) {
        toast.error("Cannot connect an agent to itself");
        return;
      }

      // Optimistically add the edge
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: "deletable",
            animated: true,
            style: { strokeWidth: 2 },
          },
          eds,
        ),
      );

      // Get existing connections for this source and add new one
      const existingConnections = getExistingConnections(connection.source);
      const newConnections = [...existingConnections, connection.target];

      // Persist to backend
      syncPromptAgents.mutate(
        {
          promptId: connection.source,
          agentPromptIds: newConnections,
        },
        {
          onError: () => {
            // Revert optimistic update on error
            setEdges((eds) =>
              eds.filter(
                (e) =>
                  !(
                    e.source === connection.source &&
                    e.target === connection.target
                  ),
              ),
            );
          },
        },
      );
    },
    [setEdges, getExistingConnections, syncPromptAgents],
  );

  // Handle edge deletion
  const onEdgesDelete = useCallback(
    (deletedEdges: Edge[]) => {
      for (const edge of deletedEdges) {
        const existingConnections = getExistingConnections(edge.source);
        const newConnections = existingConnections.filter(
          (id) => id !== edge.target,
        );

        syncPromptAgents.mutate(
          {
            promptId: edge.source,
            agentPromptIds: newConnections,
          },
          {
            onError: () => {
              // Revert by refetching
              queryClient.invalidateQueries({
                queryKey: promptAgentsQueryKeys.connections,
              });
            },
          },
        );
      }
    },
    [getExistingConnections, syncPromptAgents, queryClient],
  );

  // Wait for data to load and layout to complete
  if (isLoading || !isLayoutReady) {
    return (
      <div className="flex h-[calc(100vh-280px)] items-center justify-center">
        <p className="text-muted-foreground">Loading agents...</p>
      </div>
    );
  }

  if (prompts.length === 0) {
    return (
      <div className="flex h-[calc(100vh-280px)] items-center justify-center">
        <p className="text-muted-foreground">Create agent</p>
      </div>
    );
  }

  return (
    <AgentNodeContext.Provider value={contextValue}>
      <div className="flex flex-col gap-4">
        {/* Toolbar */}
        <div className="flex items-center justify-end gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search agents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-48 pl-8 pr-8 text-sm"
            />
            {searchQuery && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSearchQuery("")}
                className="absolute right-0.5 top-1/2 -translate-y-1/2 h-6 w-6"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <Select
            value={selectedProfileId}
            onValueChange={setSelectedProfileId}
          >
            <SelectTrigger className="!h-8 w-40 text-sm">
              <SelectValue placeholder="All Profiles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Profiles</SelectItem>
              {profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            onClick={handleAutoLayout}
            disabled={isAutoLayouting}
            className="gap-2 h-8 px-3 text-sm"
          >
            <LayoutGrid className="h-4 w-4" />
            {isAutoLayouting ? "Arranging..." : "Auto Layout"}
          </Button>
        </div>

        {/* Canvas */}
        <div className="h-[calc(100vh-340px)] w-full rounded-lg border border-border bg-background">
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            onNodeDragStop={onNodeDragStop}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={resolvedTheme === "dark" ? "dark" : "light"}
            fitView
            fitViewOptions={{ padding: 0.1, minZoom: 0.1, maxZoom: 1.5 }}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={["Backspace", "Delete"]}
            className="rounded-lg"
          >
            <Background gap={16} size={1} />
            <Controls className="!bg-card !border-border !shadow-sm [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground [&>button:hover]:!bg-muted" />
          </ReactFlow>
        </div>
      </div>

      <PromptDialog
        open={isPromptDialogOpen}
        onOpenChange={(open) => {
          setIsPromptDialogOpen(open);
          if (!open) {
            setEditingPromptId(null);
          }
        }}
        prompt={editingPrompt}
        onViewVersionHistory={setVersionHistoryPrompt}
      />

      <PromptVersionHistoryDialog
        open={!!versionHistoryPrompt}
        onOpenChange={(open) => {
          if (!open) {
            setVersionHistoryPrompt(null);
          }
        }}
        prompt={versionHistoryPrompt}
      />

      <AlertDialog
        open={!!deletingPromptId}
        onOpenChange={(open) => !open && setDeletingPromptId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Agent</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this agent? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!connectingPrompt}
        onOpenChange={(open) => !open && setConnectingPrompt(null)}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Connect to &quot;{connectingPrompt?.name}&quot;
            </DialogTitle>
            <DialogDescription>
              Use these details to connect to this agent as an A2A agent from
              your application.
            </DialogDescription>
          </DialogHeader>
          {connectingPrompt && (
            <A2AConnectionInstructions prompt={connectingPrompt} />
          )}
        </DialogContent>
      </Dialog>
    </AgentNodeContext.Provider>
  );
}

export function AgentsCanvasView() {
  return (
    <ReactFlowProvider>
      <AgentsCanvasViewInner />
    </ReactFlowProvider>
  );
}
