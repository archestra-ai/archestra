"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  formatCost,
  formatPercent,
  formatTokens,
  percentOf,
} from "@/app/llm/(costs)/costs/_parts/usage-format";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type TokenMix =
  archestraApiTypes.GetMyUsageBreakdownResponses["200"]["tokenMix"];

/**
 * The four price bands, in the order they are charged: cheapest reuse first,
 * then the two that cost full price or more.
 *
 * `multiplier` is the published rate relative to fresh input, and is what makes
 * the card worth reading: the bar is drawn in tokens, but a band's contribution
 * to the bill is its length times this number.
 */
const BANDS = [
  {
    key: "cacheReadTokens",
    label: "Cache reads",
    multiplier: "0.1x input price",
    color: "var(--chart-2)",
  },
  {
    key: "freshInputTokens",
    label: "Fresh input",
    multiplier: "1x input price",
    color: "var(--chart-1)",
  },
  {
    key: "cacheWriteTokens",
    label: "Cache writes",
    multiplier: "1.25x input price",
    color: "var(--chart-4)",
  },
  {
    key: "outputTokens",
    label: "Output",
    multiplier: "Highest rate",
    color: "var(--chart-5)",
  },
] as const satisfies readonly {
  key: keyof TokenMix;
  label: string;
  multiplier: string;
  color: string;
}[];

/**
 * What the caller's tokens were charged at, and whether caching is working.
 *
 * The cache verdict is the reason this card exists. A long agentic session is
 * supposed to read almost everything back from cache; when something changes
 * near the start of each request the cache is rewritten instead, and the same
 * work silently costs several times more with nothing in the per-request view
 * looking wrong.
 */
export function TokenMixCard({ mix }: { mix: TokenMix }) {
  const totalTokens = BANDS.reduce((sum, { key }) => sum + mix[key], 0);
  const reusableTokens = mix.cacheReadTokens + mix.freshInputTokens;
  // Of everything the model had to read, the share it did not have to be
  // charged full price for. Output is excluded: it is never cacheable, so
  // counting it would make a good hit rate look bad on verbose work.
  const cacheHitRate = percentOf(mix.cacheReadTokens, reusableTokens);
  const cachingLostMoney = mix.cacheSavings < 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where your tokens went</CardTitle>
        <CardDescription>
          Every token is charged at one of four rates, so two people with the
          same token count can pay very different amounts. Reading context back
          from cache is the cheap path; writing it is the expensive one.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {totalTokens === 0 ? (
          <p className="text-muted-foreground py-4 text-center">
            No recorded activity for the selected timeframe.
          </p>
        ) : (
          <>
            <div
              className="flex h-3 w-full overflow-hidden rounded-full"
              role="img"
              aria-label={BANDS.map(
                ({ key, label }) =>
                  `${label}: ${formatPercent(mix[key], totalTokens)}`,
              ).join(", ")}
            >
              {BANDS.map(({ key, label, color }) => (
                <div
                  key={label}
                  style={{
                    width: `${(mix[key] / totalTokens) * 100}%`,
                    backgroundColor: color,
                  }}
                />
              ))}
            </div>

            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {BANDS.map(({ key, label, multiplier, color }) => (
                <div key={label} className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className="mt-1.5 size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <div className="min-w-0">
                    <dt className="text-sm font-medium">{label}</dt>
                    <dd className="text-muted-foreground text-sm">
                      <span className="text-foreground tabular-nums">
                        {formatTokens(mix[key])}
                      </span>{" "}
                      <span>
                        ({formatPercent(mix[key], totalTokens)}), {multiplier}
                      </span>
                    </dd>
                  </div>
                </div>
              ))}
            </dl>

            <div className="rounded-md border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">Cache hit rate</span>
                <span className="text-2xl font-semibold tabular-nums">
                  {cacheHitRate}%
                </span>
              </div>
              <p className="text-muted-foreground mt-2 text-sm">
                {cachingLostMoney ? (
                  <span>
                    Caching cost {formatCost(Math.abs(mix.cacheSavings))} more
                    than paying full input price for the same tokens. That
                    happens when something near the start of each request keeps
                    changing, so every turn writes a new cache instead of
                    reading the last one.
                  </span>
                ) : (
                  <span>
                    Caching saved {formatCost(mix.cacheSavings)} against paying
                    full input price for the same tokens.
                  </span>
                )}
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
