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

// Define base positions (40px gap between groups)
// Agents: 0-160, Archestra: 200-500, Kubernetes: 540-690, Remote/LLM: 730+
const AGENTS_GROUP_X = 0;
const ARCHESTRA_GROUP_X = 200;
const KUBERNETES_GROUP_X = 620;
const REMOTE_GROUP_X = 660;
const LLM_GROUP_X = 660;

function ArchitectureDiagramInner({ activeTab }: ArchitectureDiagramProps) {
  const { resolvedTheme } = useTheme();
  const { fitView } = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const lastSizeRef = useRef<{ width: number; height: number } | null>(null);
  const initializedRef = useRef(false);

  // Re-fit view only when container actually changes size (not on re-renders)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const { width, height } = entry.contentRect;
      const lastSize = lastSizeRef.current;

      // Only refit if size actually changed significantly (>5px difference)
      if (
        lastSize &&
        Math.abs(lastSize.width - width) < 5 &&
        Math.abs(lastSize.height - height) < 5
      ) {
        return;
      }

      lastSizeRef.current = { width, height };

      // Skip first resize event - let onInit handle initial fit
      if (!initializedRef.current) {
        return;
      }

      fitView({ padding: 0.1, minZoom: 0.01, maxZoom: 2, duration: 200 });
    });
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, [fitView]);

  // Handle initial fit after ReactFlow is ready
  const onInit = useCallback(() => {
    initializedRef.current = true;
    // Small delay to ensure container has final size
    setTimeout(() => {
      fitView({ padding: 0.1, minZoom: 0.01, maxZoom: 2, duration: 0 });
    }, 50);
  }, [fitView]);

  const nodes: Node<ArchitectureNodeData | ArchitectureGroupNodeData>[] =
    useMemo(() => {
      const isProxy = activeTab === "proxy";
      const isMcp = activeTab === "mcp";
      const isA2a = activeTab === "a2a";
      // chart-1: blue (LLM Gateway), chart-2: green (MCP Gateway), chart-3: amber (A2A Gateway)
      const highlightColor = isProxy
        ? "chart-1"
        : isMcp
          ? "chart-2"
          : "chart-3";

      return [
        // Agents group
        {
          id: "agents-group",
          type: "architectureGroup",
          position: { x: AGENTS_GROUP_X, y: -50 },
          data: {
            label: "External Agents",
            width: 160,
            height: 280,
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
          position: { x: AGENTS_GROUP_X + 15, y: 52 },
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
          position: { x: AGENTS_GROUP_X + 15, y: 87 },
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
          position: { x: AGENTS_GROUP_X + 15, y: 122 },
          data: {
            label: "Support Agent",
            highlighted: isProxy,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "agent-claude-code",
          type: "architecture",
          position: { x: AGENTS_GROUP_X + 15, y: 157 },
          data: {
            label: "Claude Code",
            highlighted: isProxy,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "agent-ms-foundry",
          type: "architecture",
          position: { x: AGENTS_GROUP_X + 15, y: 192 },
          data: {
            label: "MS Foundry",
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
          position: { x: ARCHESTRA_GROUP_X, y: -230 },
          data: {
            label: "Archestra.AI",
            width: 380,
            height: 450,
            logo: "/logo.png",
            highlighted: isProxy || isMcp || isA2a,
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
          position: { x: ARCHESTRA_GROUP_X + 15, y: 130 },
          data: {
            label: "LLM Gateway",
            highlighted: isProxy,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "security-policies",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 145, y: 130 },
          data: {
            label: "Security Policies\nand Subagents",
            highlighted: isProxy,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "a2a-gateway",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 15, y: -60 },
          data: {
            label: "A2A Gateway",
            highlighted: isA2a,
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
          position: { x: REMOTE_GROUP_X, y: 50 },
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
          position: { x: REMOTE_GROUP_X + 15, y: 80 },
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

        // External A2A clients (standalone nodes on the left)
        {
          id: "slack",
          type: "architecture",
          position: { x: AGENTS_GROUP_X + 15, y: -200 },
          data: {
            label: "Slack",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "ms-teams",
          type: "architecture",
          position: { x: AGENTS_GROUP_X + 15, y: -165 },
          data: {
            label: "MS Teams",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "webhook",
          type: "architecture",
          position: { x: AGENTS_GROUP_X + 15, y: -130 },
          data: {
            label: "Webhook",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "agent-langgraph",
          type: "architecture",
          position: { x: AGENTS_GROUP_X + 15, y: -18 },
          data: {
            label: "LangChain",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "agent-bedrock",
          type: "architecture",
          position: { x: AGENTS_GROUP_X + 15, y: 17 },
          data: {
            label: "Bedrock AgentCore",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },

        // Internal agents (inside Archestra, stacked with MCP Orchestrator)
        {
          id: "chat-agent",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 145, y: -200 },
          data: {
            label: "Chat",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "ai-sre-agent",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 145, y: -155 },
          data: {
            label: "AI SRE",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "accountant-agent",
          type: "architecture",
          position: { x: ARCHESTRA_GROUP_X + 145, y: -110 },
          data: {
            label: "AI Accountant",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "observability-agent",
          type: "architecture",
          position: { x: 470, y: -185 },
          data: {
            label: "Observability",
            highlighted: isA2a,
            highlightColor,
          },
          draggable: false,
          selectable: false,
        },
        {
          id: "coding-agent",
          type: "architecture",
          position: { x: 470, y: -140 },
          data: {
            label: "Coding",
            highlighted: isA2a,
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

    // Get computed chart color from CSS variable
    const getChartColor = (chartVar: "chart-1" | "chart-2" | "chart-3") => {
      if (typeof window === "undefined") return "#888";
      const style = getComputedStyle(document.documentElement);
      const value = style.getPropertyValue(`--${chartVar}`).trim();
      return value || "#888";
    };

    const highlightedEdgeStyle = (
      color: "chart-1" | "chart-2" | "chart-3",
    ) => ({
      strokeWidth: 2,
      stroke: getChartColor(color),
      strokeDasharray: "0",
    });

    return [
      // Agent to MCP Gateway connections
      {
        id: "cursor-gw",
        source: "agent-cursor",
        target: "mcp-gateway",
        style: isMcp ? highlightedEdgeStyle("chart-2") : baseEdgeStyle,
      },
      {
        id: "n8n-gw",
        source: "agent-n8n",
        target: "mcp-gateway",
        style: isMcp ? highlightedEdgeStyle("chart-2") : baseEdgeStyle,
      },

      // Agent to LLM Gateway connections
      {
        id: "n8n-llm",
        source: "agent-n8n",
        target: "llm-gateway",
        style: isProxy ? highlightedEdgeStyle("chart-1") : baseEdgeStyle,
      },
      {
        id: "support-llm",
        source: "agent-support",
        target: "llm-gateway",
        style: isProxy ? highlightedEdgeStyle("chart-1") : baseEdgeStyle,
      },
      {
        id: "claude-code-llm",
        source: "agent-claude-code",
        target: "llm-gateway",
        style: isProxy ? highlightedEdgeStyle("chart-1") : baseEdgeStyle,
      },
      {
        id: "ms-foundry-llm",
        source: "agent-ms-foundry",
        target: "llm-gateway",
        style: isProxy ? highlightedEdgeStyle("chart-1") : baseEdgeStyle,
      },

      // MCP Gateway to Orchestrator
      {
        id: "gw-orch",
        source: "mcp-gateway",
        target: "mcp-orchestrator",
        style: isMcp ? highlightedEdgeStyle("chart-2") : baseEdgeStyle,
      },

      // Orchestrator to Kubernetes MCPs
      {
        id: "orch-jira",
        source: "mcp-orchestrator",
        target: "jira-mcp",
        style: isMcp ? highlightedEdgeStyle("chart-2") : baseEdgeStyle,
      },
      {
        id: "orch-servicenow",
        source: "mcp-orchestrator",
        target: "servicenow-mcp",
        style: isMcp ? highlightedEdgeStyle("chart-2") : baseEdgeStyle,
      },
      {
        id: "orch-custom",
        source: "mcp-orchestrator",
        target: "custom-mcp",
        style: isMcp ? highlightedEdgeStyle("chart-2") : baseEdgeStyle,
      },

      // MCP Gateway to Remote MCP
      {
        id: "gw-github",
        source: "mcp-gateway",
        target: "github-mcp",
        style: isMcp ? highlightedEdgeStyle("chart-2") : baseEdgeStyle,
      },

      // LLM Gateway to Security Policies
      {
        id: "llm-security",
        source: "llm-gateway",
        target: "security-policies",
        style: isProxy ? highlightedEdgeStyle("chart-1") : baseEdgeStyle,
      },

      // Security Policies to LLM Providers
      {
        id: "security-openai",
        source: "security-policies",
        target: "openai",
        style: isProxy ? highlightedEdgeStyle("chart-1") : baseEdgeStyle,
      },
      {
        id: "security-gemini",
        source: "security-policies",
        target: "gemini",
        style: isProxy ? highlightedEdgeStyle("chart-1") : baseEdgeStyle,
      },
      {
        id: "security-claude",
        source: "security-policies",
        target: "claude",
        style: isProxy ? highlightedEdgeStyle("chart-1") : baseEdgeStyle,
      },

      // External A2A clients to A2A Gateway
      {
        id: "slack-a2a",
        source: "slack",
        target: "a2a-gateway",
        style: isA2a ? highlightedEdgeStyle("chart-3") : baseEdgeStyle,
      },
      {
        id: "ms-teams-a2a",
        source: "ms-teams",
        target: "a2a-gateway",
        style: isA2a ? highlightedEdgeStyle("chart-3") : baseEdgeStyle,
      },
      {
        id: "webhook-a2a",
        source: "webhook",
        target: "a2a-gateway",
        style: isA2a ? highlightedEdgeStyle("chart-3") : baseEdgeStyle,
      },
      {
        id: "langgraph-a2a",
        source: "agent-langgraph",
        target: "a2a-gateway",
        style: isA2a ? highlightedEdgeStyle("chart-3") : baseEdgeStyle,
      },
      {
        id: "bedrock-a2a",
        source: "agent-bedrock",
        target: "a2a-gateway",
        style: isA2a ? highlightedEdgeStyle("chart-3") : baseEdgeStyle,
      },

      // A2A Gateway to Internal agents
      {
        id: "a2a-chat",
        source: "a2a-gateway",
        target: "chat-agent",
        style: isA2a ? highlightedEdgeStyle("chart-3") : baseEdgeStyle,
      },
      {
        id: "a2a-accountant",
        source: "a2a-gateway",
        target: "accountant-agent",
        style: isA2a ? highlightedEdgeStyle("chart-3") : baseEdgeStyle,
      },
      {
        id: "a2a-ai-sre",
        source: "a2a-gateway",
        target: "ai-sre-agent",
        style: isA2a ? highlightedEdgeStyle("chart-3") : baseEdgeStyle,
      },
      // AI SRE to Observability and Coding
      {
        id: "sre-observability",
        source: "ai-sre-agent",
        target: "observability-agent",
        style: isA2a ? highlightedEdgeStyle("chart-3") : baseEdgeStyle,
      },
      {
        id: "sre-coding",
        source: "ai-sre-agent",
        target: "coding-agent",
        style: isA2a ? highlightedEdgeStyle("chart-3") : baseEdgeStyle,
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
        onInit={onInit}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
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
          <DialogHeader className="flex flex-row items-center justify-end">
            <DialogTitle className="sr-only">Architecture Diagram</DialogTitle>
            <div className="inline-flex -space-x-px rounded-md shadow-sm mr-8">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDialogTabChange("proxy")}
                className={`rounded-none rounded-l-md ${dialogTab === "proxy" ? "text-white z-10" : ""}`}
                style={
                  dialogTab === "proxy"
                    ? {
                        backgroundColor: "var(--chart-1)",
                        borderColor: "var(--chart-1)",
                      }
                    : undefined
                }
              >
                LLM Gateway
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDialogTabChange("mcp")}
                className={`rounded-none ${dialogTab === "mcp" ? "text-white z-10" : ""}`}
                style={
                  dialogTab === "mcp"
                    ? {
                        backgroundColor: "var(--chart-2)",
                        borderColor: "var(--chart-2)",
                      }
                    : undefined
                }
              >
                MCP Gateway
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDialogTabChange("a2a")}
                className={`rounded-none rounded-r-md ${dialogTab === "a2a" ? "text-white z-10" : ""}`}
                style={
                  dialogTab === "a2a"
                    ? {
                        backgroundColor: "var(--chart-3)",
                        borderColor: "var(--chart-3)",
                      }
                    : undefined
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
