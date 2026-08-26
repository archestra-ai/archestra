"use client";

import { Badge } from "@/components/ui/badge";
import type { EvalRun } from "@/lib/evals/eval.query";

const STATUS_STYLES: Record<EvalRun["status"], string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  completed: "bg-green-500/15 text-green-700 dark:text-green-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
  canceled: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

const STATUS_LABELS: Record<EvalRun["status"], string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

export function EvalRunStatusBadge({ status }: { status: EvalRun["status"] }) {
  return (
    <Badge variant="outline" className={STATUS_STYLES[status]}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
