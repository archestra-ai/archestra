"use client";

import { LogsSectionLayout } from "@/app/_parts/logs-section-layout";

export default function ConsultLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LogsSectionLayout
      listPath="/consults/logs"
      description="Logs Guardrails requests to external services, such as labeling models or audience lookups, before a tool call is allowed or blocked."
    >
      {children}
    </LogsSectionLayout>
  );
}
