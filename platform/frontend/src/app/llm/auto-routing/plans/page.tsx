"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import {
  type AutoRoutingPlanSummary,
  useAutoRoutingPlans,
} from "@/lib/auto-routing.query";
import { formatDate } from "@/lib/utils/date-time";
import { formatCurrency } from "@/lib/utils/format-currency";
import { rejectionReason } from "../_parts/plan-document";

export default function AutoRoutingPlansPage() {
  const { data: plans = [], isPending } = useAutoRoutingPlans();

  return (
    <DataTable
      columns={COLUMNS}
      data={plans}
      getRowId={(plan) => plan.id}
      isLoading={isPending}
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
  { accessorKey: "generation", header: "Generation" },
  {
    id: "budget",
    header: "Budget",
    cell: ({ row }) => `${formatCurrency(row.original.budgetUsdPerDay)}/day`,
  },
  {
    id: "scorer",
    header: "Scorer",
    cell: ({ row }) => {
      const scorer = row.original.scorerVersion;
      return (
        <span title={scorer.specHash}>
          {scorer.name} · {scorer.model} · {scorer.specHash.slice(0, 8)}
        </span>
      );
    },
  },
  { accessorKey: "coreVersion", header: "Core" },
  { accessorKey: "decisionCount", header: "Decisions" },
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
          {row.original.error}
        </span>
      ),
  },
];
