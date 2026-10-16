"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { formatCost } from "@/components/cost";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";

type Session = Pick<
  archestraApiTypes.GetInteractionSessionsResponses["200"]["data"][number],
  | "requestCount"
  | "totalInputTokens"
  | "totalOutputTokens"
  | "totalCacheReadTokens"
  | "totalCacheWriteTokens"
  | "totalCost"
  | "totalBilledCost"
  | "totalSubscriptionCost"
  | "totalBaselineCost"
>;

export function SessionUsage({ session }: { session: Session }) {
  const subscription = Number(session.totalSubscriptionCost ?? 0);
  // A subscription-only aggregate has no metered rows, so its billed sum is null.
  const billed = Number(
    session.totalBilledCost ??
      (subscription > 0 ? 0 : (session.totalCost ?? 0)),
  );
  const amount =
    billed === 0
      ? "$0"
      : billed < 0.01
        ? formatCost(billed)
        : `$${billed.toFixed(2)}`;
  const savings = Math.max(
    0,
    Number(session.totalBaselineCost ?? session.totalCost ?? 0) -
      Number(session.totalCost ?? 0),
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          onClick={(event) => event.stopPropagation()}
          aria-label={`${session.requestCount.toLocaleString()} requests, ${amount} billed, ${session.totalInputTokens.toLocaleString()} input tokens, ${session.totalOutputTokens.toLocaleString()} output tokens${subscription > 0 ? ", includes subscription usage" : ""}`}
          className="inline-grid w-[178px] cursor-default gap-0.5 whitespace-nowrap text-left tabular-nums"
        >
          <span className="inline-flex items-baseline gap-1 text-xs leading-4">
            <span className="font-medium">{amount}</span>
            <span className="text-muted-foreground">
              total / {session.requestCount.toLocaleString()} req
            </span>
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] leading-3.5 text-muted-foreground">
            <span>
              {tokenFormatter.format(session.totalInputTokens).toLowerCase()} in
            </span>
            <span aria-hidden="true">/</span>
            <span>
              {tokenFormatter.format(session.totalOutputTokens).toLowerCase()}{" "}
              out
            </span>
            {subscription > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>sub</span>
              </>
            )}
          </span>
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 px-2 py-1.5">
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-xs tabular-nums">
          <dt className="text-muted-foreground">Requests</dt>
          <dd className="text-right">
            {session.requestCount.toLocaleString()}
          </dd>
          <dt className="text-muted-foreground">Input / output</dt>
          <dd className="text-right">
            {session.totalInputTokens.toLocaleString()} /{" "}
            {session.totalOutputTokens.toLocaleString()}
          </dd>
          {session.totalCacheReadTokens > 0 && (
            <>
              <dt className="text-muted-foreground">Cache read</dt>
              <dd className="text-right">
                {session.totalCacheReadTokens.toLocaleString()}
              </dd>
            </>
          )}
          {session.totalCacheWriteTokens > 0 && (
            <>
              <dt className="text-muted-foreground">Cache write</dt>
              <dd className="text-right">
                {session.totalCacheWriteTokens.toLocaleString()}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Billed</dt>
          <dd className="text-right">{formatCost(billed)}</dd>
          {subscription > 0 && (
            <>
              <dt className="text-muted-foreground">Subscription</dt>
              <dd className="text-right">{formatCost(subscription)}</dd>
            </>
          )}
          {savings > 0 && (
            <>
              <dt className="text-muted-foreground">Saved</dt>
              <dd className="text-right">{formatCost(savings)}</dd>
            </>
          )}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

const tokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
