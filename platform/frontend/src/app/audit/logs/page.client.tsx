"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AuditLogTable } from "./_components/audit-log-table";

export default function AuditLogsPage() {
  return (
    <div>
      <ErrorBoundary>
        <AuditLogTable />
      </ErrorBoundary>
    </div>
  );
}
