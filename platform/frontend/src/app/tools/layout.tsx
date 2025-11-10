"use client";

import { PageLayout } from "@/components/page-layout";

export default function ToolsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PageLayout
      title="Tools"
      description="Tools displayed here are either detected from requests between agents and LLMs or sourced from installed MCP servers."
      tabs={[
        { label: "Agents Assigned", href: "/tools/agents-assigned" },
        { label: "Without Agents", href: "/tools/without-agents" },
      ]}
    >
      {children}
    </PageLayout>
  );
}
