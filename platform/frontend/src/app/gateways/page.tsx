"use client";

import Link from "next/link";
import { McpConnectionInstructions } from "@/components/mcp-connection-instructions";
import { MermaidDiagram } from "@/components/mermaid-wrapper";
import { ProxyConnectionInstructions } from "@/components/proxy-connection-instructions";
import { useDefaultAgent } from "@/lib/agent.query";

export default function SettingsPage() {
  const { data: defaultAgent } = useDefaultAgent();

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
    <div className="w-full h-full">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">
            LLM & MCP Gateways
          </h1>
          <p className="text-sm text-muted-foreground">
            Archestra provides two ways to connect your agent: via LLM Proxy
            (for AI conversations) or MCP Gateway (for tool access). It will
            collect information about your agent, tools, and data from the
            traffic.
            <br />
            <br />
            Below are instructions for how to connect to Archestra using a
            default agent. If you'd like to configure a specific agent, you can
            do so in the{" "}
            <Link href="/agents" className="text-blue-500">
              Agents
            </Link>{" "}
            page.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <div className="bg-card rounded-lg p-8 shadow-sm">
          <div className="mb-8 max-w-3xl mx-auto">
            <MermaidDiagram chart={mermaidChart} id="gateway-diagram" />
          </div>

          <div className="mt-12 space-y-6">
            <div className="border-t pt-6">
              <h3 className="font-medium mb-4">Connection Options</h3>
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-3">
                  <div className="flex items-center gap-2 pb-2 border-b">
                    <h3 className="font-medium">LLM Proxy</h3>
                    <h4 className="text-sm text-muted-foreground">
                      For security, observibility and enabling tools
                    </h4>
                  </div>
                  <ProxyConnectionInstructions />
                </div>
                <div className="space-y-3">
                  <div className="flex items-center gap-2 pb-2 border-b">
                    <h3 className="font-medium">MCP Gateway</h3>
                    <h4 className="text-sm text-muted-foreground">
                      To enable tools for the agent
                    </h4>
                  </div>
                  {defaultAgent && (
                    <McpConnectionInstructions agentId={defaultAgent.id} />
                  )}
                </div>
              </div>
            </div>

            <div className="border-t pt-6">
              <h3 className="font-medium mb-4">Integration Guides</h3>
              <div className="grid grid-cols-2 gap-3">
                <a
                  href="https://www.archestra.ai/docs/platform-n8n-example"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1">
                    <div className="font-medium text-sm">N8N</div>
                    <div className="text-xs text-muted-foreground">
                      Workflow automation
                    </div>
                  </div>
                  <svg
                    className="w-4 h-4 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    role="img"
                    aria-label="Arrow icon"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </a>

                <a
                  href="https://www.archestra.ai/docs/platform-vercel-ai-example"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1">
                    <div className="font-medium text-sm">Vercel AI SDK</div>
                    <div className="text-xs text-muted-foreground">
                      TypeScript framework
                    </div>
                  </div>
                  <svg
                    className="w-4 h-4 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    role="img"
                    aria-label="Arrow icon"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </a>

                <a
                  href="https://www.archestra.ai/docs/platform-langchain-example"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1">
                    <div className="font-medium text-sm">LangChain</div>
                    <div className="text-xs text-muted-foreground">
                      Python & JS framework
                    </div>
                  </div>
                  <svg
                    className="w-4 h-4 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    role="img"
                    aria-label="Arrow icon"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </a>

                <a
                  href="https://www.archestra.ai/docs/platform-openwebui-example"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1">
                    <div className="font-medium text-sm">OpenWebUI</div>
                    <div className="text-xs text-muted-foreground">
                      Chat interface
                    </div>
                  </div>
                  <svg
                    className="w-4 h-4 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    role="img"
                    aria-label="Arrow icon"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </a>

                <a
                  href="https://www.archestra.ai/docs/platform-pydantic-example"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1">
                    <div className="font-medium text-sm">Pydantic AI</div>
                    <div className="text-xs text-muted-foreground">
                      Python framework
                    </div>
                  </div>
                  <svg
                    className="w-4 h-4 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    role="img"
                    aria-label="Arrow icon"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </a>

                <a
                  href="https://www.archestra.ai/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1">
                    <div className="font-medium text-sm">More integrations</div>
                    <div className="text-xs text-muted-foreground">
                      View all guides
                    </div>
                  </div>
                  <svg
                    className="w-4 h-4 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    role="img"
                    aria-label="Arrow icon"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
