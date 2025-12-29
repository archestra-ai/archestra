"use client";

import { MermaidDiagram } from "@/components/mermaid-wrapper";

interface ArchestraArchitectureDiagramProps {
  activeTab?: "proxy" | "mcp";
}

export function ArchestraArchitectureDiagram({
  activeTab,
}: ArchestraArchitectureDiagramProps = {}) {
  const getLLMHighlightStyles = () => {
    if (activeTab === "proxy") {
      // Edge indices for proxy path (0-based), counting from diagram definition order:
      // 0: GW --> Orch (internal)
      // 1: A1 --> GW
      // 2: A2 --> GW
      // 3: A2 --> LLM ✓
      // 4: A3 --> LLM ✓
      // 5: GW --> R1
      // 6: Orch --> S1
      // 7: Orch --> S2
      // 8: Orch --> S3
      // 9: LLM --> O ✓
      // 10: LLM --> G ✓
      // 11: LLM --> C ✓
      return `
    classDef highlightNode fill:#3b82f6,stroke:#2563eb,stroke-width:3px,color:#fff
    class LLM highlightNode
    class A2,A3,O,G,C highlightNode`;
    }
    return "";
  };

  const getMCPHighlightStyles = () => {
    if (activeTab === "mcp") {
      // Edge indices for MCP path (0-based), counting from diagram definition order:
      // 0: GW --> Orch ✓
      // 1: A1 --> GW ✓
      // 2: A2 --> GW ✓
      // 3: A2 --> LLM
      // 4: A3 --> LLM
      // 5: GW --> R1 ✓
      // 6: Orch --> S1 ✓
      // 7: Orch --> S2 ✓
      // 8: Orch --> S3 ✓
      // 9: LLM --> O
      // 10: LLM --> G
      // 11: LLM --> C
      return `
    classDef highlightNode fill:#10b981,stroke:#059669,stroke-width:3px,color:#fff
    class GW highlightNode
    class A1,A2,Orch,R1,S1,S2,S3 highlightNode`;
    }
    return "";
  };

  const highlightStyles =
    activeTab === "proxy"
      ? getLLMHighlightStyles()
      : activeTab === "mcp"
        ? getMCPHighlightStyles()
        : "";

  const mermaidChart = `flowchart LR
    subgraph Agents
        A1[Developer's Cursor]
        A2[N8N]
        A3[Support Agent]
    end

    subgraph Archestra
        GW[MCP Gateway]
        LLM[LLM Gateway]
        Orch[MCP Orchestrator]
        GW --> Orch
    end

    subgraph RightSide[" "]
        direction TB
        subgraph TopRow[" "]
            direction LR
            subgraph SelfHosted [Kubernetes]
                direction LR
                S1[Jira MCP]
                S2[ServiceNow MCP]
                S3[Custom MCP]
            end
        end

        subgraph BottomRow[" "]
            direction LR
            subgraph Remote [Remote MCP Servers]
                direction LR
                R1[GitHub MCP]
            end

            subgraph LLMs [LLM Providers]
                direction TB
                O[OpenAI]
                G[Gemini]
                C[Claude]
            end
        end

        TopRow ~~~ BottomRow
    end

    A1 --> GW
    A2 --> GW
    A2 --> LLM
    A3 --> LLM

    GW --> R1

    Orch --> S1
    Orch --> S2
    Orch --> S3

    LLM --> O
    LLM --> G
    LLM --> C

    style RightSide fill:transparent,stroke:none
    style TopRow fill:transparent,stroke:none
    style BottomRow fill:transparent,stroke:none
${highlightStyles}`;

  return (
    <div className="mb-8 max-w-3xl mx-auto aspect-[3/2] flex items-center justify-center">
      <MermaidDiagram
        chart={mermaidChart}
        id={`gateway-diagram-${activeTab || "default"}`}
      />
    </div>
  );
}
