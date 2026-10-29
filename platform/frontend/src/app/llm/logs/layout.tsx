"use client";

import { LogsSectionLayout } from "@/app/_parts/logs-section-layout";

export default function LlmLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <LogsSectionLayout listPath="/llm/logs">{children}</LogsSectionLayout>;
}
