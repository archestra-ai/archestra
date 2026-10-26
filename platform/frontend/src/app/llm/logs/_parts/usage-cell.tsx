"use client";

import { formatCost } from "@/components/cost";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  formatCompactNumber,
  formatUsageCost,
  type LogSession,
} from "./logs-table-format";

type UsageSession = Pick<
  LogSession,
  | "requestCount"
  | "failedOverCount"
  | "totalInputTokens"
  | "totalOutputTokens"
  | "totalCacheReadTokens"
  | "totalCacheWriteTokens"
  | "totalCost"
  | "totalBilledCost"
  | "totalSubscriptionCost"
  | "totalBaselineCost"
>;

/**
 * Billed spend and total tokens, right-aligned. Subscription-covered usage is
 * never billed spend: it carries a "Plan" tag, and its list price is only in
 * the tooltip.
 */
export function UsageCell({ session }: { session: UsageSession }) {
  const subscription = Number(session.totalSubscriptionCost ?? 0);
  // A subscription-only aggregate has no metered rows, so its billed sum is null.
  const billed = Number(
    session.totalBilledCost ??
      (subscription > 0 ? 0 : (session.totalCost ?? 0)),
  );
  const savings = Math.max(
    0,
    Number(session.totalBaselineCost ?? session.totalCost ?? 0) -
      Number(session.totalCost ?? 0),
  );
  const tokens = session.totalInputTokens + session.totalOutputTokens;
  const amount = formatUsageCost(billed);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={`${session.requestCount.toLocaleString()} requests, ${amount} billed, ${session.totalInputTokens.toLocaleString()} input tokens, ${session.totalOutputTokens.toLocaleString()} output tokens${subscription > 0 ? ", includes subscription usage" : ""}`}
          className="ml-auto block cursor-default text-right whitespace-nowrap tabular-nums"
        >
          <span className="flex items-center justify-end gap-1.5 text-sm leading-5">
            {subscription > 0 ? (
              <span className="rounded-sm bg-muted px-1 text-[10px] leading-4 font-medium tracking-wide text-muted-foreground uppercase">
                Plan
              </span>
            ) : null}
            <span className="font-medium">{amount}</span>
          </span>
          <span className="block text-xs leading-4 text-muted-foreground">
            {formatCompactNumber(tokens)} tokens
          </span>
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 px-2 py-1.5">
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
          <dt className="text-muted-foreground">Requests</dt>
          <dd className="text-right">
            {session.requestCount.toLocaleString()}
          </dd>
          {session.failedOverCount > 0 ? (
            <>
              <dt className="text-muted-foreground">Failed over</dt>
              <dd className="text-right">
                {session.failedOverCount.toLocaleString()}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Input / output</dt>
          <dd className="text-right">
            {session.totalInputTokens.toLocaleString()} /{" "}
            {session.totalOutputTokens.toLocaleString()}
          </dd>
          {session.totalCacheReadTokens > 0 ? (
            <>
              <dt className="text-muted-foreground">Cache read</dt>
              <dd className="text-right">
                {session.totalCacheReadTokens.toLocaleString()}
              </dd>
            </>
          ) : null}
          {session.totalCacheWriteTokens > 0 ? (
            <>
              <dt className="text-muted-foreground">Cache write</dt>
              <dd className="text-right">
                {session.totalCacheWriteTokens.toLocaleString()}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Billed</dt>
          <dd className="text-right">{formatCost(billed)}</dd>
          {subscription > 0 ? (
            <>
              <dt className="text-muted-foreground">Subscription (list)</dt>
              <dd className="text-right">{formatCost(subscription)}</dd>
            </>
          ) : null}
          {savings > 0 ? (
            <>
              <dt className="text-muted-foreground">Saved</dt>
              <dd className="text-right">{formatCost(savings)}</dd>
            </>
          ) : null}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}
