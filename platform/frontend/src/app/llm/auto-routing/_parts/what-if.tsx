"use client";

import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type AutoRoutingSimulation,
  useSimulateAutoRouting,
} from "@/lib/auto-routing.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { formatCompactNumber } from "@/lib/utils/format-compact-number";
import { formatCurrency } from "@/lib/utils/format-currency";
import { type PlanSummary, parsePlanSummary } from "./plan-document";
import { PlanSummaryView } from "./plan-summary";
import type { TierName } from "./tiers";

const MULTIPLIERS = ["0.5", "1", "1.5", "2", "3", "5", "10"] as const;
type Multiplier = (typeof MULTIPLIERS)[number];

/** The active plan re-fitted at another budget or traffic volume; nothing is saved. */
export function WhatIf({
  current,
  savedBudgetUsdPerDay,
  tierModels,
}: {
  current: PlanSummary;
  savedBudgetUsdPerDay: number;
  tierModels: Record<TierName, string>;
}) {
  const [multiplier, setMultiplier] = useState<Multiplier>("1");
  const [budgetText, setBudgetText] = useState(String(savedBudgetUsdPerDay));
  const budget = useDebouncedValue(Number(budgetText), 400);
  const changed = multiplier !== "1" || budget !== savedBudgetUsdPerDay;
  const simulation = useSimulateAutoRouting(
    changed && budget >= 0.01
      ? { budgetUsdPerDay: budget, volumeMultiplier: Number(multiplier) }
      : null,
  );

  return (
    <section
      className="space-y-3 rounded-md border p-4"
      data-testid="auto-routing-what-if"
    >
      <h3 className="text-sm font-medium">What if</h3>
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="auto-routing-what-if-traffic">Traffic</Label>
          <Select
            value={multiplier}
            onValueChange={(value) => setMultiplier(value as Multiplier)}
          >
            <SelectTrigger
              id="auto-routing-what-if-traffic"
              size="sm"
              className="w-24"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MULTIPLIERS.map((value) => (
                <SelectItem key={value} value={value}>
                  ×{value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="auto-routing-what-if-budget">Budget (USD/day)</Label>
          <Input
            id="auto-routing-what-if-budget"
            type="number"
            min={0.01}
            step={0.01}
            className="h-8 w-28"
            value={budgetText}
            onChange={(event) => setBudgetText(event.target.value)}
          />
        </div>
        <span className="pb-1.5 text-xs text-muted-foreground tabular-nums">
          {formatCompactNumber(current.tokens_per_day * Number(multiplier))}{" "}
          tokens/day (now {formatCompactNumber(current.tokens_per_day)})
        </span>
      </div>
      {!changed ? (
        <p className="text-xs text-muted-foreground">
          Change the traffic or the budget to see what the plan would do.
          Nothing is saved.
        </p>
      ) : simulation.isError ? (
        <Notice>{simulation.error.message}</Notice>
      ) : (
        simulation.data && (
          <SimulationResult
            result={simulation.data}
            budgetUsdPerDay={budget}
            tierModels={tierModels}
          />
        )
      )}
    </section>
  );
}

function SimulationResult({
  result,
  budgetUsdPerDay,
  tierModels,
}: {
  result: AutoRoutingSimulation;
  budgetUsdPerDay: number;
  tierModels: Record<TierName, string>;
}) {
  switch (result.status) {
    case "feasible": {
      const summary = parsePlanSummary(result.summary);
      return (
        summary && (
          <PlanSummaryView
            summary={summary}
            budgetUsdPerDay={budgetUsdPerDay}
            tierModels={tierModels}
          />
        )
      );
    }
    case "infeasible":
      return (
        <Notice>
          Budget too low at this traffic: the cheapest routing costs{" "}
          <span className="font-medium tabular-nums">
            {formatCurrency(result.minBudgetUsdPerDay)}/day
          </span>
          .
        </Notice>
      );
    case "cold_start":
      return (
        <p className="text-xs text-muted-foreground">
          Not enough sessions to plan yet: {result.sessions} of{" "}
          {result.required}.
        </p>
      );
  }
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <InlineNotice variant="error">
      <AlertTriangle />
      <InlineNoticeText>{children}</InlineNoticeText>
    </InlineNotice>
  );
}
