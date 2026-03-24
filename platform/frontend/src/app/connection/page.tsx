"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArchestraArchitectureDiagram } from "@/components/archestra-architecture-diagram";
import type { ArchitectureTabType } from "@/components/architecture-diagram/architecture-diagram";
import { ConnectionOptions } from "@/components/connection-options";
import { PageLayout } from "@/components/page-layout";
import { useDefaultLlmProxy, useDefaultMcpGateway } from "@/lib/agent.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

export default function ConnectionPage() {
  const { data: defaultMcpGateway } = useDefaultMcpGateway();
  const { data: defaultLlmProxy } = useDefaultLlmProxy();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");

  const [activeTab, setActiveTab] = useState<ArchitectureTabType>(
    tabParam === "mcp" ? "mcp" : tabParam === "a2a" ? "a2a" : "proxy",
  );
  const integrationGuides = [
    {
      href: getFrontendDocsUrl("platform-n8n-example"),
      title: "N8N",
      subtitle: "Workflow automation",
    },
    {
      href: getFrontendDocsUrl("platform-vercel-ai-example"),
      title: "Vercel AI SDK",
      subtitle: "TypeScript framework",
    },
    {
      href: getFrontendDocsUrl("platform-openwebui-example"),
      title: "OpenWebUI",
      subtitle: "Chat interface",
    },
    {
      href: getFrontendDocsUrl("platform-pydantic-example"),
      title: "Pydantic AI",
      subtitle: "Python framework",
    },
    {
      href: getFrontendDocsUrl("platform-quickstart"),
      title: "More integrations",
      subtitle: "View all guides",
    },
  ].filter(
    (guide): guide is typeof guide & { href: string } => guide.href !== null,
  );

  useEffect(() => {
    if (tabParam === "mcp" || tabParam === "proxy" || tabParam === "a2a") {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  return (
    <PageLayout
      title="Connect"
      description="Choose how your apps connect to agents with LLM Proxy, MCP Gateway, or A2A."
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
                mcpGatewayId={defaultMcpGateway?.id}
                llmProxyId={defaultLlmProxy?.id}
                activeTab={activeTab}
                onTabChange={setActiveTab}
              />
            </div>
          </div>
        </div>

        {/* Integration Guides */}
        {integrationGuides.length > 0 && (
          <div className="border-t pt-8">
            <h2 className="text-lg font-medium mb-4">Integration Guides</h2>
            <div className="grid grid-cols-2 gap-3">
              {integrationGuides.map((guide) => (
                <a
                  key={guide.title}
                  href={guide.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1">
                    <div className="font-medium text-sm">{guide.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {guide.subtitle}
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
              ))}
            </div>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
