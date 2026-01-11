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

interface ArchitectureDiagramProps {
  activeTab?: "proxy" | "mcp";
  onTabChange?: (tab: "proxy" | "mcp") => void;
}

const nodeTypes = {
  architecture: ArchitectureNode,
  architectureGroup: ArchitectureGroupNode,
};

// Define base positions (40px gap between groups)
// Agents: 0-160, Archestra: 200-500, Kubernetes: 540-690, Remote/LLM: 730+
const AGENTS_GROUP_X = 0;
const ARCHESTRA_GROUP_X = 200;
const KUBERNETES_GROUP_X = 540;
const REMOTE_GROUP_X = 730;
const LLM_GROUP_X = 730;

function ArchitectureDiagramInner({ activeTab }: ArchitectureDiagramProps) {
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
      const highlightColor = isProxy ? "blue" : "green";

      return [
        // Agents group
        {
          id: "agents-group",
          type: "architectureGroup",
          position: { x: AGENTS_GROUP_X, y: 0 },
          data: {
            label: "External Agents",
            width: 160,
            height: 190,
            highlighted: isProxy || isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // Agent nodes
        {
          id: "agent-cursor",
          type: "architecture",
          position: { x: AGENTS_GROUP_X + 15, y: 32 },
          data: {
            label: "Developer's Cursor",
            highlighted: isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "agent-n8n",
          type: "architecture",
          position: { x: AGENTS_GROUP_X + 15, y: 80 },
          data: {
            label: "n8n",
            highlighted: isProxy || isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "agent-support",
          type: "architecture",
          position: { x: AGENTS_GROUP_X + 15, y: 128 },
          data: {
            label: "Support Agent",
            highlighted: isProxy,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },

        // Archestra group
        {
          id: "archestra-group",
          type: "architectureGroup",
          position: { x: ARCHESTRA_GROUP_X, y: -40 },
          data: {
            label: "Archestra.AI",
            width: 300,
            height: 260,
            logo: "/logo.png",
            highlighted: isProxy || isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // Archestra nodes
        {
          id: "mcp-gateway",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 15, y: 50 },
          data: {
            label: "MCP Gateway",
            highlighted: isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "mcp-orchestrator",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 145, y: 0 },
          data: {
            label: "MCP Orchestrator",
            highlighted: isMcp,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "llm-gateway",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 80, y: 130 },
          data: {
            label: "LLM Gateway",
            highlighted: isProxy,
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
          position: { x: REMOTE_GROUP_X, y: 0 },
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
          position: { x: REMOTE_GROUP_X + 15, y: 30 },
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
          position: { x: LLM_GROUP_X, y: 140 },
          data: {
            label: "LLM Providers",
            width: 140,
            height: 185,
            highlighted: isProxy,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        // LLM Provider nodes
        {
          id: "openai",
          type: "architecture",
          position: { x: LLM_GROUP_X + 15, y: 170 },
          data: {
            label: "OpenAI",
            highlighted: isProxy,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "gemini",
          type: "architecture",
          position: { x: LLM_GROUP_X + 15, y: 205 },
          data: {
            label: "Gemini",
            highlighted: isProxy,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "claude",
          type: "architecture",
          position: { x: LLM_GROUP_X + 15, y: 240 },
          data: {
            label: "Claude",
            highlighted: isProxy,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "more-llm",
          type: "architecture",
          position: { x: LLM_GROUP_X + 15, y: 275 },
          data: {
            label: "and more...",
            highlighted: isProxy,
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

    const baseEdgeStyle = {
      strokeWidth: 1.5,
      strokeDasharray: "5,5",
    };

    const highlightedEdgeStyle = (color: "blue" | "green") => ({
      strokeWidth: 2,
      stroke: color === "blue" ? "#3b82f6" : "#10b981",
      strokeDasharray: "0",
    });

    return [
      // Agent to MCP Gateway connections
      {
        id: "cursor-gw",
        source: "agent-cursor",
        target: "mcp-gateway",
        style: isMcp ? highlightedEdgeStyle("green") : baseEdgeStyle,
      },
      {
        id: "n8n-gw",
        source: "agent-n8n",
        target: "mcp-gateway",
        style: isMcp ? highlightedEdgeStyle("green") : baseEdgeStyle,
      },

      // Agent to LLM Gateway connections
      {
        id: "n8n-llm",
        source: "agent-n8n",
        target: "llm-gateway",
        style: isProxy ? highlightedEdgeStyle("blue") : baseEdgeStyle,
      },
      {
        id: "support-llm",
        source: "agent-support",
        target: "llm-gateway",
        style: isProxy ? highlightedEdgeStyle("blue") : baseEdgeStyle,
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
        style: isProxy ? highlightedEdgeStyle("blue") : baseEdgeStyle,
      },
      {
        id: "llm-gemini",
        source: "llm-gateway",
        target: "gemini",
        style: isProxy ? highlightedEdgeStyle("blue") : baseEdgeStyle,
      },
      {
        id: "llm-claude",
        source: "llm-gateway",
        target: "claude",
        style: isProxy ? highlightedEdgeStyle("blue") : baseEdgeStyle,
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
  const [dialogTab, setDialogTab] = useState<"proxy" | "mcp">(
    activeTab || "proxy",
  );

  // Sync dialog tab with external activeTab when dialog opens
  const handleOpenChange = (open: boolean) => {
    if (open && activeTab) {
      setDialogTab(activeTab);
    }
    setIsExpanded(open);
  };

  const handleDialogTabChange = (tab: "proxy" | "mcp") => {
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
