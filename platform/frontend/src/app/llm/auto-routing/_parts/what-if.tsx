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
  type AutoRoutingSettings,
  type AutoRoutingSimulation,
  type SimulatedTraffic,
  useSimulateAutoRouting,
} from "@/lib/auto-routing.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { formatCompactNumber } from "@/lib/utils/format-compact-number";
import { formatCurrency } from "@/lib/utils/format-currency";
import { useFittedTierModels } from "./fitted-tier-models";
import { parsePlanSummary } from "./plan-document";
import { PlanSummaryView } from "./plan-summary";

const MULTIPLIERS = ["0.5", "1", "1.5", "2", "3", "5", "10"] as const;
type Multiplier = (typeof MULTIPLIERS)[number];

/** The active plan re-fitted at another budget or traffic volume; nothing is saved. */
export function WhatIf({
  savedBudgetUsdPerDay,
  savedTiers,
}: {
  savedBudgetUsdPerDay: number;
  savedTiers: AutoRoutingSettings["tiers"];
}) {
  const [multiplier, setMultiplier] = useState<Multiplier>("1");
  const [budgetText, setBudgetText] = useState(String(savedBudgetUsdPerDay));
  const budget = Number(budgetText);
  const debouncedBudget = useDebouncedValue(budget, 400);
  const valid = budgetText.trim() !== "" && budget >= 0.01;
  const changed = multiplier !== "1" || budget !== savedBudgetUsdPerDay;
  const simulation = useSimulateAutoRouting(
    changed && valid && debouncedBudget === budget
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
      </div>
      {!changed ? (
        <p className="text-xs text-muted-foreground">
          Change the traffic or the budget to see what the plan would do.
          Nothing is saved.
        </p>
      ) : !valid ? null : simulation.isError ? (
        <Notice>{simulation.error.message}</Notice>
      ) : simulation.data ? (
        <SimulationResult
          result={simulation.data}
          budgetUsdPerDay={budget}
          multiplier={Number(multiplier)}
          savedTiers={savedTiers}
        />
      ) : (
        <p className="text-xs text-muted-foreground">Simulating…</p>
      )}
    </section>
  );
}

function SimulationResult({
  result,
  budgetUsdPerDay,
  multiplier,
  savedTiers,
}: {
  result: AutoRoutingSimulation;
  budgetUsdPerDay: number;
  multiplier: number;
  savedTiers: AutoRoutingSettings["tiers"];
}) {
  switch (result.status) {
    case "feasible":
      return (
        <FeasibleResult
          result={result}
          budgetUsdPerDay={budgetUsdPerDay}
          multiplier={multiplier}
          savedTiers={savedTiers}
        />
      );
    case "infeasible":
      return (
        <>
          <Traffic baseline={result.baseline} multiplier={multiplier} />
          <Notice>
            Budget too low at this traffic: the cheapest routing costs{" "}
            <span className="font-medium tabular-nums">
              {formatCurrency(result.minBudgetUsdPerDay)}/day
            </span>
            .
          </Notice>
        </>
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

function FeasibleResult({
  result,
  budgetUsdPerDay,
  multiplier,
  savedTiers,
}: {
  result: Extract<AutoRoutingSimulation, { status: "feasible" }>;
  budgetUsdPerDay: number;
  multiplier: number;
  savedTiers: AutoRoutingSettings["tiers"];
}) {
  const tierModels = useFittedTierModels(result.tiersFingerprint, savedTiers);
  const summary = parsePlanSummary(result.summary);
  return (
    <>
      <Traffic baseline={result.baseline} multiplier={multiplier} />
      {summary && (
        <PlanSummaryView
          summary={summary}
          budgetUsdPerDay={budgetUsdPerDay}
          tierModels={tierModels}
        />
      )}
    </>
  );
}

/** The simulated traffic next to the fitted usage window's. */
function Traffic({
  baseline,
  multiplier,
}: {
  baseline: SimulatedTraffic;
  multiplier: number;
}) {
  const rate = (traffic: SimulatedTraffic, scale: number) =>
    `${formatCompactNumber(traffic.tokensPerDay * scale)} tokens/day, ${formatCompactNumber(traffic.sessionsPerDay * scale)} sessions/day`;
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      {rate(baseline, multiplier)} (now {rate(baseline, 1)})
    </p>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <InlineNotice variant="error">
      <AlertTriangle />
      <InlineNoticeText>{children}</InlineNoticeText>
    </InlineNotice>
  );
}
