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
        profile. If you'd like to configure a specific profile, you can do so in
        the{" "}
        <Link href="/profiles" className="text-blue-500">
          Profiles
        </Link>{" "}
        page.
      </p>

      <div className="mb-8 max-w-3xl mx-auto aspect-[3/2] flex items-center justify-center">
        <MermaidDiagram chart={mermaidChart} id="gateway-diagram" />
      </div>
    </>
  );
}
