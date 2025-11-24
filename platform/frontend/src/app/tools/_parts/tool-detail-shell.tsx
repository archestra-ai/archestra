"use client";

import { Loader2 } from "lucide-react";
import { useMemo } from "react";
import { PageLayout } from "@/components/page-layout";
import { TruncatedText } from "@/components/truncated-text";
import { useTool } from "@/lib/tool.query";
import type { Tool } from "./types";

export function ToolDetailShell({
  toolId,
  children,
}: {
  toolId: string;
  children: (tool: Tool) => React.ReactNode;
}) {
  const { data: tool, isLoading, error } = useTool(toolId);

  const tabs = useMemo(
    () => [
      { label: "Policies", href: `/tools/${toolId}/policies` },
      { label: "Assignments", href: `/tools/${toolId}/assignments` },
    ],
    [toolId],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !tool) {
    return (
      <div className="p-8 text-sm text-destructive">
        {error instanceof Error ? error.message : "Tool not found."}
      </div>
    );
  }

  return (
    <PageLayout
      title={tool.name}
      description={
        tool.description ? (
          <TruncatedText message={tool.description} maxLength={500} />
        ) : (
          "Tool configuration and assignments"
        )
      }
      tabs={tabs.map((tab) => ({
        ...tab,
        href: tab.href,
      }))}
    >
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
        {children(tool)}
      </div>
    </PageLayout>
  );
}
