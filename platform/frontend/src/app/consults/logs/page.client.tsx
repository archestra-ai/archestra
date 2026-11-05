"use client";

import { ErrorBoundary } from "@/components/error-boundary";
import { ConsultsTable } from "./_parts/consults-table";

export default function ConsultLogsPage() {
  return (
    <ErrorBoundary>
      <ConsultsTable />
    </ErrorBoundary>
  );
}
