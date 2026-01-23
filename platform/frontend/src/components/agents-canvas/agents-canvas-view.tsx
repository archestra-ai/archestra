"use client";

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
import { AgentDialog } from "@/components/agent-dialog";
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
import {
  useDeleteProfile,
  useInternalAgents,
  useProfile,
  useProfiles,
} from "@/lib/agent.query";
import {
  agentDelegationsQueryKeys,
  useAllDelegationConnections,
  useSyncAgentDelegations,
} from "@/lib/agent-tools.query";
import { AgentNode, type AgentNodeData } from "./agent-node";
import { AgentNodeContext } from "./agent-node-context";
import { DeletableEdge } from "./deletable-edge";
import { resolveCollisions } from "./resolve-collisions";
import { useLayoutNodes } from "./use-layout-nodes";

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
  const { data: internalAgents = [], isLoading: isLoadingAgents } =
    useInternalAgents();
  const { data: profiles = [] } = useProfiles();
  const { data: delegationData, isLoading: isLoadingConnections } =
    useAllDelegationConnections();
  const connections = delegationData?.connections ?? [];
  const syncAgentDelegations = useSyncAgentDelegations();

  const isLoading = isLoadingAgents || isLoadingConnections;
  const [isLayoutReady, setIsLayoutReady] = useState(false);
  const [isAutoLayouting, setIsAutoLayouting] = useState(false);

  // Dialog state - now using agents directly
  const [isAgentDialogOpen, setIsAgentDialogOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const [connectingAgentId, setConnectingAgentId] = useState<string | null>(
    null,
  );
  const [versionHistoryAgentId, setVersionHistoryAgentId] = useState<
    string | null
  >(null);

  // Lookup agent data for dialogs
  const { data: editingAgent } = useProfile(editingAgentId ?? undefined);
  const connectingAgent = useMemo(
    () => internalAgents.find((a) => a.id === connectingAgentId) ?? null,
    [internalAgents, connectingAgentId],
  );
  const versionHistoryAgent = useMemo(
    () => internalAgents.find((a) => a.id === versionHistoryAgentId) ?? null,
    [internalAgents, versionHistoryAgentId],
  );
  const deleteAgentMutation = useDeleteProfile();

  const handleEditAgent = useCallback((agentId: string) => {
    setEditingAgentId(agentId);
    setIsAgentDialogOpen(true);
  }, []);

  const handleDeleteAgent = useCallback((agentId: string) => {
    setDeletingAgentId(agentId);
  }, []);

  const handleConnectAgent = useCallback((agentId: string) => {
    setConnectingAgentId(agentId);
  }, []);

  const confirmDelete = useCallback(() => {
    if (deletingAgentId) {
      deleteAgentMutation.mutate(deletingAgentId);
      setDeletingAgentId(null);
    }
  }, [deletingAgentId, deleteAgentMutation]);

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
  const prevAgentsRef = useRef<typeof internalAgents>([]);
  const prevConnectionsRef = useRef<typeof connections>([]);
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
      internalAgents
        .filter((agent) => {
          const matchesSearch =
            !hasSearch || agent.name.toLowerCase().includes(query);
          // For internal agents, filter by whether they match the selected profile
          // (external profiles can still be referenced via teams)
          const matchesProfile =
            !hasProfileFilter || agent.id === selectedProfileId;
          return matchesSearch && matchesProfile;
        })
        .map((a) => a.id),
    );

    // Also include children of matching agents (recursive)
    const matchingIds = new Set(directMatchIds);
    const addChildren = (parentId: string) => {
      for (const conn of connections) {
        if (
          conn.sourceAgentId === parentId &&
          !matchingIds.has(conn.targetAgentId)
        ) {
          matchingIds.add(conn.targetAgentId);
          addChildren(conn.targetAgentId); // Recursively add grandchildren
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
  }, [nodes, searchQuery, selectedProfileId, internalAgents, connections]);

  // Save positions whenever nodes change (after initial load)
  useEffect(() => {
    if (isLayoutReady && nodes.length > 0 && initialLoadDone.current) {
      savePositions(nodes);
    }
  }, [nodes, isLayoutReady]);

  // Load nodes with saved positions or apply auto-layout for new nodes
  useEffect(() => {
    if (isLoading || internalAgents.length === 0) {
      return;
    }

    const prevAgentIds = new Set(prevAgentsRef.current.map((a) => a.id));
    const currentAgentIds = new Set(internalAgents.map((a) => a.id));
    const newAgentIds = internalAgents
      .filter((a) => !prevAgentIds.has(a.id))
      .map((a) => a.id);

    const agentsChanged =
      JSON.stringify([...currentAgentIds].sort()) !==
      JSON.stringify([...prevAgentIds].sort());

    // Check if agent data changed (e.g., name updated)
    const prevAgentData = new Map(
      prevAgentsRef.current.map((a) => [a.id, a.name]),
    );
    const agentDataChanged = internalAgents.some(
      (a) => prevAgentData.get(a.id) !== a.name,
    );

    // Check if connections changed (delegated agents added/removed)
    const prevConnectionIds = new Set(
      prevConnectionsRef.current.map(
        (c) => `${c.sourceAgentId}-${c.targetAgentId}`,
      ),
    );
    const currentConnectionIds = new Set(
      connections.map((c) => `${c.sourceAgentId}-${c.targetAgentId}`),
    );
    const connectionsChanged =
      JSON.stringify([...currentConnectionIds].sort()) !==
      JSON.stringify([...prevConnectionIds].sort());

    if (
      !agentsChanged &&
      !agentDataChanged &&
      !connectionsChanged &&
      isLayoutReady
    ) {
      return;
    }

    const savedPositions = loadSavedPositions();

    // Create edges
    const initialEdges: Edge[] = connections.map((conn) => ({
      id: `${conn.sourceAgentId}-${conn.targetAgentId}`,
      source: conn.sourceAgentId,
      target: conn.targetAgentId,
      sourceHandle: "tools",
      type: "deletable",
      animated: true,
      style: { strokeWidth: 2 },
    }));

    // Check if this is a new agent being added (not initial load)
    const isNewAgentAdded =
      initialLoadDone.current && newAgentIds.length > 0 && isLayoutReady;

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

        for (let i = 0; i < newAgentIds.length; i++) {
          const agentId = newAgentIds[i];
          const agent = internalAgents.find((a) => a.id === agentId);
          if (agent) {
            newNodes.push({
              id: agent.id,
              type: "agent" as const,
              position: {
                x: startX,
                y: topY + i * 100,
              },
              data: { label: agent.name, promptId: agent.id },
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
      prevAgentsRef.current = internalAgents;
      prevConnectionsRef.current = connections;
      return;
    }

    const hasAllPositions = internalAgents.every((a) => savedPositions[a.id]);

    if (hasAllPositions) {
      // Use saved positions
      const nodesWithPositions: Node<AgentNodeData>[] = internalAgents.map(
        (agent) => ({
          id: agent.id,
          type: "agent" as const,
          position: savedPositions[agent.id],
          data: { label: agent.name, promptId: agent.id },
        }),
      );
      setNodes(nodesWithPositions);
      setEdges(initialEdges);
      setIsLayoutReady(true);
      prevAgentsRef.current = internalAgents;
      prevConnectionsRef.current = connections;
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
      const initialNodes: Node<AgentNodeData>[] = internalAgents.map(
        (agent) => ({
          id: agent.id,
          type: "agent" as const,
          position: savedPositions[agent.id] ?? { x: 0, y: 0 },
          data: { label: agent.name, promptId: agent.id },
        }),
      );

      getLayoutedNodes(initialNodes, initialEdges).then((layoutedNodes) => {
        setNodes(layoutedNodes);
        setEdges(initialEdges);
        setIsLayoutReady(true);
        prevAgentsRef.current = internalAgents;
        prevConnectionsRef.current = connections;
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
    internalAgents,
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
        .filter((conn) => conn.sourceAgentId === sourceId)
        .map((conn) => conn.targetAgentId);
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
      syncAgentDelegations.mutate(
        {
          agentId: connection.source,
          targetAgentIds: newConnections,
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
    [setEdges, getExistingConnections, syncAgentDelegations],
  );

  // Handle edge deletion
  const onEdgesDelete = useCallback(
    (deletedEdges: Edge[]) => {
      for (const edge of deletedEdges) {
        const existingConnections = getExistingConnections(edge.source);
        const newConnections = existingConnections.filter(
          (id) => id !== edge.target,
        );

        syncAgentDelegations.mutate(
          {
            agentId: edge.source,
            targetAgentIds: newConnections,
          },
          {
            onError: () => {
              // Revert by refetching
              queryClient.invalidateQueries({
                queryKey: agentDelegationsQueryKeys.connections,
              });
            },
          },
        );
      }
    },
    [getExistingConnections, syncAgentDelegations, queryClient],
  );

  // Wait for data to load and layout to complete
  if (isLoading || !isLayoutReady) {
    return (
      <div className="flex h-[calc(100vh-280px)] items-center justify-center">
        <p className="text-muted-foreground">Loading agents...</p>
      </div>
    );
  }

  if (internalAgents.length === 0) {
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

      <AgentDialog
        open={isAgentDialogOpen}
        onOpenChange={(open) => {
          setIsAgentDialogOpen(open);
          if (!open) {
            setEditingAgentId(null);
          }
        }}
        agent={editingAgent}
        agentType="agent"
        onViewVersionHistory={(agent) => setVersionHistoryAgentId(agent.id)}
      />

      <PromptVersionHistoryDialog
        open={!!versionHistoryAgent}
        onOpenChange={(open) => {
          if (!open) {
            setVersionHistoryAgentId(null);
          }
        }}
        agent={versionHistoryAgent}
      />

      <AlertDialog
        open={!!deletingAgentId}
        onOpenChange={(open) => !open && setDeletingAgentId(null)}
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
        open={!!connectingAgent}
        onOpenChange={(open) => !open && setConnectingAgentId(null)}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Connect to &quot;{connectingAgent?.name}&quot;
            </DialogTitle>
            <DialogDescription>
              Use these details to connect to this agent as an A2A agent from
              your application.
            </DialogDescription>
          </DialogHeader>
          {connectingAgent && (
            <A2AConnectionInstructions agent={connectingAgent} />
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
