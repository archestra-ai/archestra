"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ConsultsTable } from "./_components/consults-table";

export default function ConsultLogsPage() {
  return (
    <ErrorBoundary>
      <ConsultsTable />
    </ErrorBoundary>
  );
}
