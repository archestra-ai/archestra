"use client";

import {
  Controls,
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Maximize2 } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArchitectureGroupNode,
  type ArchitectureGroupNodeData,
} from "./architecture-group-node";
import {
  ArchitectureNode,
  type ArchitectureNodeData,
} from "./architecture-node";

export type ArchitectureTabType = "proxy" | "mcp" | "a2a";

interface ArchitectureDiagramProps {
  activeTab?: ArchitectureTabType;
  onTabChange?: (tab: ArchitectureTabType) => void;
}

const nodeTypes = {
  architecture: ArchitectureNode,
  architectureGroup: ArchitectureGroupNode,
};

// Define base positions
const EXTERNAL_GROUP_X = 0;
const ARCHESTRA_GROUP_X = 180;
const KUBERNETES_GROUP_X = 540;
const REMOTE_GROUP_X = 730;
const LLM_GROUP_X = 730;

function ArchitectureDiagramInner({
  activeTab,
}: Pick<ArchitectureDiagramProps, "activeTab">) {
  const { resolvedTheme } = useTheme();
  const { fitView } = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);

  // Re-fit view when container resizes
  const handleResize = useCallback(() => {
    fitView({ padding: 0.1, minZoom: 0.01, maxZoom: 2, duration: 200 });
  }, [fitView]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, [handleResize]);

  const nodes: Node<ArchitectureNodeData | ArchitectureGroupNodeData>[] =
    useMemo(() => {
      const isProxy = activeTab === "proxy";
      const isMcp = activeTab === "mcp";
      const isA2a = activeTab === "a2a";

      const getHighlightColor = () => {
        if (isProxy) return "blue";
        if (isMcp) return "green";
        if (isA2a) return "orange";
        return "blue";
      };
      const highlightColor = getHighlightColor();

      return [
        // External sources group
        {
          id: "external-group",
          type: "architectureGroup",
          position: { x: EXTERNAL_GROUP_X, y: 0 },
          data: {
            label: "External Sources",
            width: 150,
            height: 190,
            highlighted: isProxy || isMcp || isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // External source nodes
        {
          id: "ms-teams",
          type: "architecture",
          position: { x: EXTERNAL_GROUP_X + 15, y: 32 },
          data: {
            label: "MS Teams",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "slack",
          type: "architecture",
          position: { x: EXTERNAL_GROUP_X + 15, y: 80 },
          data: {
            label: "Slack",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "external-agents",
          type: "architecture",
          position: { x: EXTERNAL_GROUP_X + 15, y: 128 },
          data: {
            label: "External Agents",
            highlighted: isProxy || isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },

        // Archestra group
        {
          id: "archestra-group",
          type: "architectureGroup",
          position: { x: ARCHESTRA_GROUP_X, y: -80 },
          data: {
            label: "Archestra.AI",
            width: 320,
            height: 340,
            logo: "/logo.png",
            highlighted: isProxy || isMcp || isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // A2A Gateway
        {
          id: "a2a-gateway",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 15, y: -45 },
          data: {
            label: "A2A Gateway",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // Internal A2A Agents group
        {
          id: "internal-agents-group",
          type: "architectureGroup",
          position: { x: ARCHESTRA_GROUP_X + 15, y: 10 },
          data: {
            label: "Internal A2A Agents",
            width: 290,
            height: 100,
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // Internal agent nodes
        {
          id: "internal-agent-1",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 30, y: 45 },
          data: {
            label: "Agent 1",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "internal-agent-2",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 120, y: 45 },
          data: {
            label: "Agent 2",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "internal-agent-more",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 210, y: 45 },
          data: {
            label: "...",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // MCP Gateway
        {
          id: "mcp-gateway",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 15, y: 140 },
          data: {
            label: "MCP Gateway",
            highlighted: isMcp || isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // MCP Orchestrator
        {
          id: "mcp-orchestrator",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 165, y: 140 },
          data: {
            label: "MCP Orchestrator",
            highlighted: isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // LLM Gateway
        {
          id: "llm-gateway",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 90, y: 210 },
          data: {
            label: "LLM Gateway",
            highlighted: isProxy || isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },

        // Kubernetes group
        {
          id: "kubernetes-group",
          type: "architectureGroup",
          position: { x: KUBERNETES_GROUP_X, y: -120 },
          data: {
            label: "Kubernetes",
            width: 150,
            height: 150,
            highlighted: isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // Kubernetes MCP nodes
        {
          id: "jira-mcp",
          type: "architecture",
          position: { x: KUBERNETES_GROUP_X + 15, y: -88 },
          data: {
            label: "Jira MCP",
            highlighted: isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "servicenow-mcp",
          type: "architecture",
          position: { x: KUBERNETES_GROUP_X + 15, y: -50 },
          data: {
            label: "ServiceNow MCP",
            highlighted: isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "custom-mcp",
          type: "architecture",
          position: { x: KUBERNETES_GROUP_X + 15, y: -12 },
          data: {
            label: "Custom MCP",
            highlighted: isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },

        // Remote MCP Servers group
        {
          id: "remote-group",
          type: "architectureGroup",
          position: { x: REMOTE_GROUP_X, y: 40 },
          data: {
            label: "Remote MCP Servers",
            width: 140,
            height: 70,
            highlighted: isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // Remote MCP node
        {
          id: "github-mcp",
          type: "architecture",
          position: { x: REMOTE_GROUP_X + 15, y: 70 },
          data: {
            label: "GitHub MCP",
            highlighted: isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },

        // LLM Providers group
        {
          id: "llm-group",
          type: "architectureGroup",
          position: { x: LLM_GROUP_X, y: 120 },
          data: {
            label: "LLM Providers",
            width: 140,
            height: 185,
            highlighted: isProxy || isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // LLM Provider nodes
        {
          id: "openai",
          type: "architecture",
          position: { x: LLM_GROUP_X + 15, y: 150 },
          data: {
            label: "OpenAI",
            highlighted: isProxy || isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "gemini",
          type: "architecture",
          position: { x: LLM_GROUP_X + 15, y: 185 },
          data: {
            label: "Gemini",
            highlighted: isProxy || isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "claude",
          type: "architecture",
          position: { x: LLM_GROUP_X + 15, y: 220 },
          data: {
            label: "Claude",
            highlighted: isProxy || isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "more-llm",
          type: "architecture",
          position: { x: LLM_GROUP_X + 15, y: 255 },
          data: {
            label: "and more...",
            highlighted: isProxy || isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
      ];
    }, [activeTab]);

  const edges: Edge[] = useMemo(() => {
    const isProxy = activeTab === "proxy";
    const isMcp = activeTab === "mcp";
    const isA2a = activeTab === "a2a";

    const baseEdgeStyle = {
      strokeWidth: 1.5,
      strokeDasharray: "5,5",
    };

    const highlightedEdgeStyle = (color: "blue" | "green" | "orange") => ({
      strokeWidth: 2,
      stroke:
        color === "blue"
          ? "#3b82f6"
          : color === "green"
            ? "#10b981"
            : "#f59e0b",
      strokeDasharray: "0",
    });

    return [
      // External to A2A Gateway (A2A flow)
      {
        id: "teams-a2a",
        source: "ms-teams",
        target: "a2a-gateway",
        style: isA2a ? highlightedEdgeStyle("orange") : baseEdgeStyle,
      },
      {
        id: "slack-a2a",
        source: "slack",
        target: "a2a-gateway",
        style: isA2a ? highlightedEdgeStyle("orange") : baseEdgeStyle,
      },

      // External agents to MCP Gateway
      {
        id: "external-mcp",
        source: "external-agents",
        target: "mcp-gateway",
        style: isMcp ? highlightedEdgeStyle("green") : baseEdgeStyle,
      },

      // External agents to LLM Gateway
      {
        id: "external-llm",
        source: "external-agents",
        target: "llm-gateway",
        style: isProxy ? highlightedEdgeStyle("blue") : baseEdgeStyle,
      },

      // A2A Gateway to Internal Agents
      {
        id: "a2a-internal1",
        source: "a2a-gateway",
        target: "internal-agent-1",
        style: isA2a ? highlightedEdgeStyle("orange") : baseEdgeStyle,
      },
      {
        id: "a2a-internal2",
        source: "a2a-gateway",
        target: "internal-agent-2",
        style: isA2a ? highlightedEdgeStyle("orange") : baseEdgeStyle,
      },

      // Internal Agents to MCP Gateway
      {
        id: "internal1-mcp",
        source: "internal-agent-1",
        target: "mcp-gateway",
        style: isA2a ? highlightedEdgeStyle("orange") : baseEdgeStyle,
      },

      // Internal Agents to LLM Gateway
      {
        id: "internal2-llm",
        source: "internal-agent-2",
        target: "llm-gateway",
        style: isA2a ? highlightedEdgeStyle("orange") : baseEdgeStyle,
      },

      // MCP Gateway to Orchestrator
      {
        id: "gw-orch",
        source: "mcp-gateway",
        target: "mcp-orchestrator",
        style: isMcp ? highlightedEdgeStyle("green") : baseEdgeStyle,
      },

      // Orchestrator to Kubernetes MCPs
      {
        id: "orch-jira",
        source: "mcp-orchestrator",
        target: "jira-mcp",
        style: isMcp ? highlightedEdgeStyle("green") : baseEdgeStyle,
      },
      {
        id: "orch-servicenow",
        source: "mcp-orchestrator",
        target: "servicenow-mcp",
        style: isMcp ? highlightedEdgeStyle("green") : baseEdgeStyle,
      },
      {
        id: "orch-custom",
        source: "mcp-orchestrator",
        target: "custom-mcp",
        style: isMcp ? highlightedEdgeStyle("green") : baseEdgeStyle,
      },

      // MCP Gateway to Remote MCP
      {
        id: "gw-github",
        source: "mcp-gateway",
        target: "github-mcp",
        style: isMcp ? highlightedEdgeStyle("green") : baseEdgeStyle,
      },

      // LLM Gateway to LLM Providers
      {
        id: "llm-openai",
        source: "llm-gateway",
        target: "openai",
        style:
          isProxy || isA2a
            ? highlightedEdgeStyle(isA2a ? "orange" : "blue")
            : baseEdgeStyle,
      },
      {
        id: "llm-gemini",
        source: "llm-gateway",
        target: "gemini",
        style:
          isProxy || isA2a
            ? highlightedEdgeStyle(isA2a ? "orange" : "blue")
            : baseEdgeStyle,
      },
      {
        id: "llm-claude",
        source: "llm-gateway",
        target: "claude",
        style:
          isProxy || isA2a
            ? highlightedEdgeStyle(isA2a ? "orange" : "blue")
            : baseEdgeStyle,
      },
    ];
  }, [activeTab]);

  return (
    <div ref={containerRef} className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
        fitView
        fitViewOptions={{ padding: 0.1, minZoom: 0.01, maxZoom: 2 }}
        proOptions={{ hideAttribution: true }}
        panOnDrag={true}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        preventScrolling={false}
        className="rounded-lg"
      >
        <Controls
          showInteractive={false}
          className="!bg-card !border-border !shadow-sm [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground [&>button:hover]:!bg-muted"
        />
      </ReactFlow>
    </div>
  );
}

export function ArchitectureDiagram({
  activeTab,
  onTabChange,
}: ArchitectureDiagramProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [dialogTab, setDialogTab] = useState<ArchitectureTabType>(
    activeTab || "proxy",
  );

  // Sync dialog tab with external activeTab when dialog opens
  const handleOpenChange = (open: boolean) => {
    if (open && activeTab) {
      setDialogTab(activeTab);
    }
    setIsExpanded(open);
  };

  const handleDialogTabChange = (tab: ArchitectureTabType) => {
    setDialogTab(tab);
    onTabChange?.(tab);
  };

  return (
    <>
      <div className="relative w-full h-full">
        <ReactFlowProvider>
          <ArchitectureDiagramInner activeTab={activeTab} />
        </ReactFlowProvider>
        <Button
          variant="outline"
          size="icon"
          className="absolute top-2 right-2 h-8 w-8 bg-card"
          onClick={() => setIsExpanded(true)}
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={isExpanded} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-[90vw] w-[90vw] h-[85vh] flex flex-col">
          <DialogHeader className="flex flex-row items-center justify-between">
            <DialogTitle>Architecture Diagram</DialogTitle>
            <div className="flex gap-1 mr-8">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDialogTabChange("proxy")}
                className={
                  dialogTab === "proxy"
                    ? "bg-blue-500 border-blue-600 text-white hover:bg-blue-600 hover:text-white"
                    : ""
                }
              >
                LLM Gateway
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDialogTabChange("mcp")}
                className={
                  dialogTab === "mcp"
                    ? "bg-emerald-500 border-emerald-600 text-white hover:bg-emerald-600 hover:text-white"
                    : ""
                }
              >
                MCP Gateway
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDialogTabChange("a2a")}
                className={
                  dialogTab === "a2a"
                    ? "bg-amber-500 border-amber-600 text-white hover:bg-amber-600 hover:text-white"
                    : ""
                }
              >
                A2A Gateway
              </Button>
            </div>
          </DialogHeader>
          <div className="flex-1 min-h-0">
            <ReactFlowProvider>
              <ArchitectureDiagramInner activeTab={dialogTab} />
            </ReactFlowProvider>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
