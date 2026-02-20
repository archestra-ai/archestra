"use client";

import { PageLayout } from "@/components/page-layout";

export default function ToolsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PageLayout
      title="Tool Policies"
      description="Tools displayed here are either detected from requests between agents and LLMs or sourced from installed MCP servers."
    >
      {children}
    </PageLayout>
  );
}
