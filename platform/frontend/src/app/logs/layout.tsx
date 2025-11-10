"use client";

import { PageLayout } from "@/components/page-layout";

export default function LogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PageLayout
      title="Logs"
      description="View all logs including LLM proxy interactions and MCP gateway tool calls."
      tabs={[
        { label: "LLM Proxy", href: "/logs/llm-proxy" },
        { label: "MCP Gateway", href: "/logs/mcp-gateway" },
      ]}
    >
      {children}
    </PageLayout>
  );
}
