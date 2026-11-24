"use client";

import { LogsSectionLayout } from "@/app/_parts/logs-section-layout";

export default function McpLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <LogsSectionLayout listPath="/mcp/logs">{children}</LogsSectionLayout>;
}
