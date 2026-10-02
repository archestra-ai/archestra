"use client";

import { LogsSectionLayout } from "@/app/_parts/logs-section-layout";

export default function AuditLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LogsSectionLayout listPath="/audit/logs">{children}</LogsSectionLayout>
  );
}
