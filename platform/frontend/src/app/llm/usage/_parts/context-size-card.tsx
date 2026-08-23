"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  formatPercent,
  formatTokens,
  percentOf,
} from "@/app/llm/usage/_parts/usage-format";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ContextBucket =
  archestraApiTypes.GetMyUsageBreakdownResponses["200"]["contextBuckets"][number];

/** Plain-language names for the bands the API returns, in the same order. */
const BUCKET_LABELS: Record<ContextBucket["bucket"], string> = {
  under32k: "Under 32K",
  under128k: "32K to 128K",
  under256k: "128K to 256K",
  over256k: "Over 256K",
};

/**
 * How large the caller's requests were, and where the money sat.
 *
 * The distribution is the finding, not any single request: in a long session
 * every turn re-reads the whole conversation, so context grows monotonically
 * and the last turns of a session can cost many times what the first ones did.
 * Nothing in a per-request log makes that visible.
 */
export function ContextSizeCard({ buckets }: { buckets: ContextBucket[] }) {
  const totalCost = buckets.reduce((sum, { cost }) => sum + cost, 0);
  const totalRequests = buckets.reduce(
    (sum, { requests }) => sum + requests,
    0,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Context size</CardTitle>
        <CardDescription>
          How much the model was asked to read on each request, counting both
          fresh and cached tokens. Share is of cost, not of request count, so a
          band with few but very large requests shows its real weight.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {totalRequests === 0 ? (
          <p className="text-muted-foreground py-4 text-center">
            No recorded activity for the selected timeframe.
          </p>
        ) : (
          <ul className="space-y-4">
            {buckets.map((bucket) => {
              const share = percentOf(bucket.cost, totalCost);
              const shareLabel = formatPercent(bucket.cost, totalCost);
              return (
                <li key={bucket.bucket} className="space-y-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-sm font-medium">
                      {BUCKET_LABELS[bucket.bucket]}
                    </span>
                    <span className="text-muted-foreground text-sm tabular-nums">
                      {shareLabel} of cost, {bucket.requests.toLocaleString()}{" "}
                      requests, {formatTokens(bucket.tokens)} tokens
                    </span>
                  </div>
                  <div
                    className="bg-muted h-2 w-full overflow-hidden rounded-full"
                    role="img"
                    aria-label={`${BUCKET_LABELS[bucket.bucket]}: ${shareLabel} of cost`}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${share}%`,
                        backgroundColor: "var(--chart-1)",
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
