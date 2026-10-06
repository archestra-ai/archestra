"use client";

import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AgentAdoptionOverview } from "./_components/agent-adoption";
import { ConnectionLogTable } from "./_components/connection-log-table";

export default function ConnectionLogsPage() {
  return (
    <div className="space-y-8">
      <ErrorBoundary>
        <AgentAdoptionOverview />
      </ErrorBoundary>
      <section aria-labelledby="connection-log" className="space-y-2">
        <div>
          <h2 id="connection-log" className="text-sm font-semibold">
            Connection log
          </h2>
          <p className="text-xs text-muted-foreground">
            Each setup downloaded from the Connect page, and each disconnect.
          </p>
        </div>
        <ErrorBoundary>
          <ConnectionLogTable />
        </ErrorBoundary>
      </section>
    </div>
  );
}
