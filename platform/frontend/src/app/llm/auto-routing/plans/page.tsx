"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import {
  type AutoRoutingPlanSummary,
  useAutoRoutingPlans,
} from "@/lib/auto-routing.query";
import { formatDate } from "@/lib/utils/date-time";
import { formatCurrency } from "@/lib/utils/format-currency";
import {
  describeFitError,
  parsePlanSummary,
  rejectionReason,
} from "../_parts/plan-document";

export default function AutoRoutingPlansPage() {
  const query = useAutoRoutingPlans();
  if (query.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load plan history"
        error={query.error}
        onRetry={() => query.refetch()}
      />
    );
  }

  return (
    <DataTable
      columns={COLUMNS}
      data={query.data ?? []}
      getRowId={(plan) => plan.id}
      isLoading={query.isPending}
      emptyMessage="No plans yet"
    />
  );
}

const COLUMNS: ColumnDef<AutoRoutingPlanSummary>[] = [
  {
    id: "createdAt",
    header: "Created",
    cell: ({ row }) => formatDate({ date: row.original.createdAt }),
  },
  { accessorKey: "trigger", header: "Trigger" },
  {
    id: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge variant={row.original.status === "active" ? "default" : "outline"}>
        {row.original.status}
      </Badge>
    ),
  },
  {
    id: "budget",
    header: "Budget",
    cell: ({ row }) => `${formatCurrency(row.original.budgetUsdPerDay)}/day`,
  },
  {
    id: "expectedSpend",
    header: "Expected spend",
    cell: ({ row }) => {
      const summary = parsePlanSummary(row.original.summary);
      return summary ? `${formatCurrency(summary.expected_spend)}/day` : null;
    },
  },
  {
    id: "tierSplit",
    header: "Sessions fast / normal / smart",
    cell: ({ row }) => {
      const summary = parsePlanSummary(row.original.summary);
      return summary
        ? summary.tier_session_share
            .map((share) => `${Math.round(share * 100)}%`)
            .join(" / ")
        : null;
    },
  },
  { accessorKey: "decisionCount", header: "Decisions" },
  {
    id: "versions",
    header: "Versions",
    cell: ({ row }) => {
      const { scorerVersion: scorer, coreVersion } = row.original;
      return (
        <span
          className="text-xs text-muted-foreground"
          title={`Scorer ${scorer.name} · ${scorer.model} · ${scorer.specHash}\nRouter core ${coreVersion}`}
        >
          {scorer.model} · {coreVersion}
        </span>
      );
    },
  },
  {
    id: "error",
    header: "Error",
    cell: ({ row }) =>
      row.original.status === "rejected" ? (
        <span className="line-clamp-2 text-muted-foreground">
          {rejectionReason(row.original.error)}
        </span>
      ) : (
        <span className="line-clamp-2 text-destructive">
          {row.original.error && describeFitError(row.original.error).message}
        </span>
      ),
  },
];
