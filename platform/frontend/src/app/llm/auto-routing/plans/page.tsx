"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type AutoRoutingPlanSummary,
  useAutoRoutingPlans,
} from "@/lib/auto-routing.query";
import { formatDate } from "@/lib/utils/date-time";
import { formatCurrency } from "@/lib/utils/format-currency";
import { PlanDiagnostics } from "../_parts/plan-diagnostics";

export default function AutoRoutingPlansPage() {
  const { data: plans = [], isPending } = useAutoRoutingPlans();
  const [selected, setSelected] = useState<AutoRoutingPlanSummary | null>(null);

  return (
    <>
      <DataTable
        columns={COLUMNS}
        data={plans}
        getRowId={(plan) => plan.id}
        onRowClick={setSelected}
        isLoading={isPending}
        emptyMessage="No plans yet"
      />
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Plan of{" "}
              {selected ? formatDate({ date: selected.createdAt }) : null}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            {selected && <PlanDiagnostics planId={selected.id} />}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
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
    cell: ({ row }) => (
      <span className="line-clamp-2 text-destructive">
        {row.original.error}
      </span>
    ),
  },
];
