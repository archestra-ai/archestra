"use client";

import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer } from "@/components/ui/chart";
import { formatCurrency } from "@/lib/utils/format-currency";
import { BUDGET_PRESET_LABELS, type BudgetPreset } from "./budget-presets";
import type { PlanSummary } from "./plan-document";
import { TIER_COLOR, TIER_NAMES, type TierName } from "./tiers";

export function PlanSummaryView({
  summary,
  budgetUsdPerDay,
  budgetPreset = null,
  tierModels,
}: {
  summary: PlanSummary;
  budgetUsdPerDay: number;
  /** Named next to the budget when the budget comes from it. */
  budgetPreset?: BudgetPreset | null;
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
            {budgetPreset && (
              <span> · {BUDGET_PRESET_LABELS[budgetPreset]}</span>
            )}
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
      <TierSplit
        sessionShare={summary.tier_session_share}
        tokenShare={summary.tier_token_share}
        tierModels={tierModels}
      />
    </div>
  );
}

/** The plan summary before a first plan exists: the same tiles, empty, and where sessions go meanwhile. */
export function PlanSummaryPlaceholder({
  budgetUsdPerDay,
  budgetPreset,
  tierModels,
}: {
  budgetUsdPerDay: number | null;
  budgetPreset: BudgetPreset | null;
  tierModels: Record<TierName, string>;
}) {
  // Without a plan every session goes to the normal tier.
  const allNormal = TIER_NAMES.map((tier) => (tier === "normal" ? 1 : 0));
  return (
    <div className="space-y-4" data-testid="auto-routing-plan-placeholder">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <PendingTile
          label="Expected spend"
          note={
            budgetPreset
              ? `${BUDGET_PRESET_LABELS[budgetPreset]} budget`
              : budgetUsdPerDay !== null
                ? `of ${formatCurrency(budgetUsdPerDay)} budget`
                : null
          }
        />
        <PendingTile label="Quality vs all-smart" />
        <PendingTile label="Extra $10/day" />
        <PendingTile label="Sessions/day" />
      </div>
      <TierSplit
        sessionShare={allNormal}
        tokenShare={allNormal}
        tierModels={tierModels}
      />
    </div>
  );
}

function PendingTile({
  label,
  note = null,
}: {
  label: string;
  note?: string | null;
}) {
  return (
    <SummaryTile label={label}>
      <span className="text-2xl font-semibold text-muted-foreground">–</span>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </SummaryTile>
  );
}

function TierSplit({
  sessionShare,
  tokenShare,
  tierModels,
}: {
  sessionShare: number[];
  tokenShare: number[];
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
  const row = (name: string, shares: number[]) => ({
    name,
    ...Object.fromEntries(TIER_NAMES.map((tier, i) => [tier, shares[i]])),
  });
  const data = [row("Sessions", sessionShare), row("Tokens", tokenShare)];

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Where sessions go</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        <ChartContainer config={config} className="aspect-auto h-24 w-full">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ left: 4, right: 12 }}
          >
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
                {config[tier].label}: {formatPercent(sessionShare[i])} sessions,{" "}
                {formatPercent(tokenShare[i])} tokens
              </span>
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
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
    <Card className="gap-1 px-4 py-4">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </span>
      {children}
    </Card>
  );
}

export function formatPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}
