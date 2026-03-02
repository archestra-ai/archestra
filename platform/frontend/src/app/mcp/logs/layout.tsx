"use client";

import { PageLayout } from "@/components/page-layout";
import { LOGS_LAYOUT_CONFIG } from "@/config/logs-layout";

export default function McpLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <PageLayout {...LOGS_LAYOUT_CONFIG}>{children}</PageLayout>;
}
