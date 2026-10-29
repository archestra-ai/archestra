"use client";

import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer } from "@/components/ui/chart";
import { formatCurrency } from "@/lib/utils/format-currency";
import type { PlanSummary } from "./plan-document";
import { TIER_COLOR, TIER_NAMES, type TierName } from "./tiers";

export function PlanSummaryView({
  summary,
  budgetUsdPerDay,
  tierModels,
}: {
  summary: PlanSummary;
  budgetUsdPerDay: number;
  tierModels: Record<TierName, string>;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile label="Expected spend">
          <span className="text-2xl font-semibold tabular-nums">
            {formatCurrency(summary.expected_spend)}/day
          </span>
          <span className="text-xs text-muted-foreground">
            of {formatCurrency(budgetUsdPerDay)} budget
          </span>
        </SummaryTile>
        <SummaryTile label="Quality vs all-smart">
          <span className="text-2xl font-semibold tabular-nums">
            {formatPercent(summary.value_size_weighted)}
          </span>
        </SummaryTile>
        <SummaryTile label="Extra $10/day">
          <span className="text-2xl font-semibold tabular-nums">
            +{(summary.value_per_usd * 10 * 100).toFixed(1)} points
          </span>
          <span className="text-xs text-muted-foreground">of quality</span>
        </SummaryTile>
        <SummaryTile label="Sessions/day">
          <span className="text-2xl font-semibold tabular-nums">
            {Math.round(summary.sessions_per_day).toLocaleString("en-US")}
          </span>
        </SummaryTile>
      </div>
      <TierSplit summary={summary} tierModels={tierModels} />
    </div>
  );
}

function TierSplit({
  summary,
  tierModels,
}: {
  summary: PlanSummary;
  tierModels: Record<TierName, string>;
}) {
  const config: ChartConfig = Object.fromEntries(
    TIER_NAMES.map((tier) => [
      tier,
      {
        label: `${tier} · ${tierModels[tier]}`,
        color: TIER_COLOR[tier].css,
      },
    ]),
  );
  const row = (name: string, shares: PlanSummary["tier_session_share"]) => ({
    name,
    ...Object.fromEntries(TIER_NAMES.map((tier, i) => [tier, shares[i]])),
  });
  const data = [
    row("Sessions", summary.tier_session_share),
    row("Tokens", summary.tier_token_share),
  ];

  return (
    <div className="space-y-2">
      <ChartContainer config={config} className="aspect-auto h-24 w-full">
        <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12 }}>
          <XAxis type="number" domain={[0, 1]} hide />
          <YAxis
            type="category"
            dataKey="name"
            width={72}
            tickLine={false}
            axisLine={false}
          />
          {TIER_NAMES.map((tier) => (
            <Bar
              key={tier}
              dataKey={tier}
              stackId="share"
              fill={`var(--color-${tier})`}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ChartContainer>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {TIER_NAMES.map((tier, i) => (
          <span key={tier} className="flex items-center gap-1.5">
            <span
              className={`size-2.5 rounded-sm ${TIER_COLOR[tier].swatch}`}
            />
            <span>
              {config[tier].label}:{" "}
              {formatPercent(summary.tier_session_share[i])} sessions,{" "}
              {formatPercent(summary.tier_token_share[i])} tokens
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-4">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </span>
      {children}
    </div>
  );
}

export function formatPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}
