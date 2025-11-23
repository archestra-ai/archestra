"use client";

import { Suspense, useState } from "react";
import { LoadingSpinner } from "@/components/loading";
import { ErrorBoundary } from "../_parts/error-boundary";
import { ToolDetailsDialog } from "./_parts/tool-details-dialog";
import { ToolsTable } from "./_parts/tools-table";
import type { Tool } from "./_parts/types";

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
  const [selectedToolForDialog, setSelectedToolForDialog] =
    useState<Tool | null>(null);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      <ToolsTable onToolClick={setSelectedToolForDialog} />

      <ToolDetailsDialog
        tool={selectedToolForDialog}
        open={!!selectedToolForDialog}
        onOpenChange={(open: boolean) =>
          !open && setSelectedToolForDialog(null)
        }
      />
    </div>
  );
}
