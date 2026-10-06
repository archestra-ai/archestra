"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { MemberConnectionsTable } from "./_components/member-connections-table";

export default function ConnectionLogsPage() {
  return (
    <div>
      <ErrorBoundary>
        <MemberConnectionsTable />
      </ErrorBoundary>
    </div>
  );
}
