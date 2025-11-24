"use client";

import { Suspense } from "react";
import { LoadingSpinner } from "@/components/loading";
import { ErrorBoundary } from "../_parts/error-boundary";
import { ToolsTable } from "./_parts/tools-table";

export function ToolsClient() {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner className="mt-[30vh]" />}>
          <ToolsList />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function ToolsList() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      <ToolsTable />
    </div>
  );
}
