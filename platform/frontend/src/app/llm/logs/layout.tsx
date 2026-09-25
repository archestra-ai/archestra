"use client";

import { LogsSectionLayout } from "@/app/_parts/logs-section-layout";
import { ResourceListActions } from "@/components/resource-list-actions";

export default function LlmLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LogsSectionLayout
      listPath="/llm/logs"
      actionButton={<ResourceListActions resource="log" />}
    >
      {children}
    </LogsSectionLayout>
  );
}
