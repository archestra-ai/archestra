"use client";

import { ArchestraArchitectureDiagram } from "@/components/archestra-architecture-diagram";
import { ConnectionOptions } from "@/components/connection-options";
import { useDefaultAgent } from "@/lib/agent.query";

export default function GatewaysSettingsPage() {
  const { data: defaultAgent } = useDefaultAgent();

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      <div className="bg-card rounded-lg p-8 shadow-sm">
        <ArchestraArchitectureDiagram />

        <div className="mt-12 space-y-6">
          <div className="border-t pt-6">
            <ConnectionOptions agentId={defaultAgent?.id} />
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
  );
}
