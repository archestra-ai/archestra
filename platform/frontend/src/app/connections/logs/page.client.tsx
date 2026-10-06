"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ConnectionLogTable } from "./_components/connection-log-table";

export default function ConnectionLogsPage() {
  return (
    <div>
      <ErrorBoundary>
        <ConnectionLogTable />
      </ErrorBoundary>
    </div>
  );
}
