"use client";

import { PageLayout } from "@/components/page-layout";

export default function McpLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PageLayout
      title="Logs"
      description="View all logs including LLM proxy interactions and MCP gateway tool calls."
      tabs={[
        { label: "LLM Proxy", href: "/llm/logs" },
        { label: "MCP Gateway", href: "/mcp/logs" },
      ]}
    >
      {children}
    </PageLayout>
  );
}
