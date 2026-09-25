"use client";

import { LogsSectionLayout } from "@/app/_parts/logs-section-layout";
import { ResourceListActions } from "@/components/resource-list-actions";

export default function McpLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LogsSectionLayout
      listPath="/mcp/logs"
      actionButton={<ResourceListActions resource="log" />}
    >
      {children}
    </LogsSectionLayout>
  );
}
