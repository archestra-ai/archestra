"use client";

import { PageLayout } from "@/components/page-layout";
import { useLogsLayoutConfig } from "@/lib/audit-log/use-logs-layout-config";

export default function McpLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const config = useLogsLayoutConfig();
  return <PageLayout {...config}>{children}</PageLayout>;
}
