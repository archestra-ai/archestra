"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { QueryLoadError } from "@/components/query-load-error";
import { DataTable } from "@/components/ui/data-table";
import { useLimits } from "@/lib/limits.query";
import { formatCost } from "./cost-explorer.query";

type Allowance = {
  id: string;
  model: string;
  period: string;
  behavior: string;
  used: number | null;
  cap: number;
  estimated: boolean;
  lastReset: string;
};
const columns: ColumnDef<Allowance>[] = [
  { accessorKey: "model", header: "Models" },
  { accessorKey: "period", header: "Reset period" },
  { accessorKey: "lastReset", header: "Last reset" },
  { accessorKey: "behavior", header: "Enforcement" },
  {
    accessorKey: "used",
    header: "Current usage",
    cell: ({ row }) =>
      row.original.used === null
        ? "Unavailable"
        : `${formatCost(row.original.used)}${row.original.estimated ? " (estimated)" : ""}`,
  },
  {
    accessorKey: "cap",
    header: "Allowance",
    cell: ({ row }) => formatCost(row.original.cap),
  },
  {
    id: "remaining",
    header: "Remaining / over",
    cell: ({ row }) =>
      row.original.used === null
        ? "Unavailable"
        : row.original.used > row.original.cap
          ? `${formatCost(row.original.used - row.original.cap)} over`
          : `${formatCost(row.original.cap - row.original.used)} remaining`,
  },
];

export function TeamAllowances({
  teamId,
  teamName,
}: {
  teamId: string;
  teamName: string;
}) {
  const query = useLimits({
    filters: { entityType: "team", entityId: teamId, limitType: "token_cost" },
  });
  const rows: Allowance[] = (query.data ?? []).map((l) => ({
    id: l.id,
    model: l.model?.join(", ") || "All models",
    period: l.cleanupInterval ?? "No reset",
    behavior: l.behavior,
    used: l.modelUsage?.reduce((n, m) => n + m.cost, 0) ?? null,
    cap: l.limitValue,
    estimated: !!l.estimatedUsage,
    lastReset: l.lastCleanup
      ? new Date(l.lastCleanup).toLocaleString()
      : "Not recorded",
  }));
  return (
    <div className="space-y-3 border-t p-4">
      <h2 className="text-sm font-semibold">Current allowances · {teamName}</h2>
      <p className="text-xs text-muted-foreground">
        Current allowance period; includes descendant charges.
      </p>
      {query.isError ? (
        <QueryLoadError
          title="Could not load allowances"
          onRetry={() => query.refetch()}
          error={query.error}
        />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={query.isPending}
          emptyMessage="No direct team spend limit. Ancestor and organization limits can still apply."
        />
      )}
    </div>
  );
}
