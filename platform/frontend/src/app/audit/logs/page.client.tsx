"use client";

import { ErrorBoundary } from "@/components/error-boundary";
import { AuditLogTable } from "./_parts/audit-log-table";

export default function AuditLogsPage() {
  return (
    <div>
      <ErrorBoundary>
        <AuditLogTable />
      </ErrorBoundary>
    </div>
  );
}
