"use client";

import { Activity, ShieldCheck, ShieldX } from "lucide-react";

export function AuditLogSummaryCards({
  totalCount,
  allowedCount,
  blockedOrFailedCount,
}: {
  totalCount: number;
  allowedCount: number;
  blockedOrFailedCount: number;
}) {
  return (
    <div className="mb-4 grid gap-3 md:grid-cols-3">
      <div className="rounded-md border p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Activity className="h-4 w-4" />
          Loaded events
        </div>
        <div className="mt-2 text-2xl font-semibold">{totalCount}</div>
      </div>
      <div className="rounded-md border p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="h-4 w-4" />
          Allowed
        </div>
        <div className="mt-2 text-2xl font-semibold">{allowedCount}</div>
      </div>
      <div className="rounded-md border p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldX className="h-4 w-4" />
          Blocked or failed
        </div>
        <div className="mt-2 text-2xl font-semibold">
          {blockedOrFailedCount}
        </div>
      </div>
    </div>
  );
}
