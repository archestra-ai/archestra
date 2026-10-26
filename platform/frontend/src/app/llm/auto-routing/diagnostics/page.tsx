"use client";

import { useAutoRoutingSettings } from "@/lib/auto-routing.query";
import { PlanDiagnostics } from "../_parts/plan-diagnostics";

export default function AutoRoutingDiagnosticsPage() {
  const { data: settings, isPending } = useAutoRoutingSettings();
  if (isPending) return null;
  const activePlan = settings?.status.activePlan;
  if (!activePlan) {
    return (
      <p className="text-sm text-muted-foreground">
        No active plan yet. Fitted models appear here once a plan is published.
      </p>
    );
  }
  return <PlanDiagnostics planId={activePlan.id} />;
}
