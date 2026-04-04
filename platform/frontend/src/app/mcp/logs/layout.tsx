"use client";

import { PageLayout } from "@/components/page-layout";
import { LOGS_LAYOUT_CONFIG } from "@/consts";

export default function McpLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <PageLayout {...LOGS_LAYOUT_CONFIG}>{children}</PageLayout>;
}
