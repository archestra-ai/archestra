"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArchestraArchitectureDiagram } from "@/components/archestra-architecture-diagram";
import type { ArchitectureTabType } from "@/components/architecture-diagram/architecture-diagram";
import { ConnectionOptions } from "@/components/connection-options";
import { PageLayout } from "@/components/page-layout";
import { PermissivePolicyBar } from "@/components/permissive-policy-bar";
import { useDefaultProfile } from "@/lib/agent.query";

export default function ConnectionPage() {
  const { data: defaultProfile } = useDefaultProfile();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");

  const [activeTab, setActiveTab] = useState<ArchitectureTabType>(
    tabParam === "mcp" ? "mcp" : tabParam === "a2a" ? "a2a" : "proxy",
  );

  useEffect(() => {
    if (tabParam === "mcp" || tabParam === "proxy" || tabParam === "a2a") {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  return (
    <>
      <span id="chunk-test" style={{ visibility: "hidden" }}>
        {" "}
      </span>
      <PermissivePolicyBar />
      <PageLayout
        title="Connect"
        description="Connect your AI agents through LLM Gateway or MCP Gateway"
      >
        <div className="space-y-8">
          {/* Architecture & Connection */}
          <div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
              <div>
                <ArchestraArchitectureDiagram
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                />
              </div>
              <div>
                <ConnectionOptions
                  agentId={defaultProfile?.id}
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                />
              </div>
            </div>
          </div>

          {/* Integration Guides */}
          <div className="border-t pt-8">
            <h2 className="text-lg font-medium mb-4">Integration Guides</h2>
            <div className="grid grid-cols-2 gap-3">
              <a
                href="https://archestra.ai/docs/platform-n8n-example"
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
                href="https://archestra.ai/docs/platform-vercel-ai-example"
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
                href="https://archestra.ai/docs/platform-langchain-example"
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
                href="https://archestra.ai/docs/platform-openwebui-example"
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
                href="https://archestra.ai/docs/platform-pydantic-example"
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
                href="https://archestra.ai/docs"
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
      </PageLayout>
    </>
  );
}
