"use client";

import Link from "next/link";
import { MermaidDiagram } from "@/components/mermaid-wrapper";

export function ArchestraArchitectureDiagram() {
  const mermaidChart = `flowchart LR
    subgraph Agents
        A1[Developer's Cursor]
        A2[N8N]
        A3[Support Agent]
    end

    subgraph Archestra
        GW[MCP Gateway]
        Orch["<b>MCP Orchestrator</b>"]
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

        end

        TopRow ~~~ BottomRow
    end

    A1 --> GW
    A2 --> GW
    A3 --> GW

    GW --> R1

    Orch --> S1
    Orch --> S2
    Orch --> S3


    style RightSide fill:transparent,stroke:none
    style TopRow fill:transparent,stroke:none
    style BottomRow fill:transparent,stroke:none`;

  return (
    <>
      <p className="text-sm text-muted-foreground mb-8">
        Archestra provides two ways to connect your agent: via LLM Proxy (for AI
        conversations) or MCP Gateway (for tool access). It will collect
        information about your agent, tools, and data from the traffic.
        <br />
        <br />
        Below are instructions for how to connect to Archestra using a default
        agent. If you'd like to configure a specific agent, you can do so in the{" "}
        <Link href="/agents" className="text-blue-500">
          Agents
        </Link>{" "}
        page.
      </p>

      <div className="mb-8 max-w-3xl mx-auto">
        <MermaidDiagram chart={mermaidChart} id="gateway-diagram" />
      </div>
    </>
  );
}
