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
      description="What Guardrails recorded: its requests to external services, such as labeling models or audience lookups, and the yells agents raised about blocks they could not get past."
    >
      {children}
    </LogsSectionLayout>
  );
}
