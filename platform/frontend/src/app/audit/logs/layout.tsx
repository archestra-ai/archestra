"use client";

import { LogsSectionLayout } from "@/app/_parts/logs-section-layout";
import { ResourceListActions } from "@/components/resource-list-actions";

export default function AuditLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LogsSectionLayout
      listPath="/audit/logs"
      actionButton={<ResourceListActions resource="auditLog" />}
    >
      {children}
    </LogsSectionLayout>
  );
}
