import type { archestraApiTypes, BillingMode } from "@archestra/shared";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCost } from "./cost";
import { Savings } from "./savings";

/**
 * Cost display that distinguishes billed spend from subscription-covered usage.
 *
 * `cost` is the list-price estimate. `subscriptionCost` is the portion of that
 * estimate covered by a flat-rate subscription (e.g. Claude Code on a Max/Pro
 * plan) — it incurs no per-token charge, so it is NOT billed. When present, we
 * show the billed spend (which may be $0) plus a "Subscription" badge and a
 * tooltip breaking out the would-be list price, instead of presenting the full
 * list price as if it were money spent.
 *
 * When there is no subscription-covered cost, this defers entirely to
 * {@link Savings} so the metered path (and its optimization-savings tooltip) is
 * unchanged.
 */
export function BilledCost({
  cost,
  billedCost,
  subscriptionCost,
  billingMode,
  baselineCost,
  toonCostSavings,
  toonTokensBefore,
  toonTokensAfter,
  toonSkipReason,
  baselineModel,
  actualModel,
  format = "percent",
  tooltip = "never",
  variant = "default",
  className,
}: {
  /** Full list-price estimate (all rows). */
  cost: string;
  /** Billed spend: metered-only cost. Falls back to `cost` when not provided. */
  billedCost?: string | null;
  /** Would-be list price of subscription-covered rows (not billed). */
  subscriptionCost?: string | null;
  /**
   * Single-interaction convenience: when `subscription`, the whole `cost` is
   * subscription-covered (billed $0). Ignored when billedCost/subscriptionCost
   * are provided (the aggregate/session case).
   */
  billingMode?: BillingMode | null;
  baselineCost: string;
  toonCostSavings?: string | null;
  toonTokensBefore?: number | null;
  toonTokensAfter?: number | null;
  toonSkipReason?:
    | archestraApiTypes.GetInteractionResponses["200"]["toonSkipReason"]
    | null;
  baselineModel?: string | null;
  actualModel?: string | null;
  format?: "percent" | "number";
  tooltip?: "never" | "always" | "hover";
  variant?: "default" | "session" | "interaction";
  className?: string;
}) {
  // Derive the split from billingMode when explicit sums aren't supplied.
  const derivedBilled =
    billedCost ?? (billingMode === "subscription" ? "0" : null);
  const derivedSubscription =
    subscriptionCost ?? (billingMode === "subscription" ? cost : null);

  const subscription = derivedSubscription
    ? Number.parseFloat(derivedSubscription)
    : 0;

  if (subscription <= 0) {
    return (
      <Savings
        cost={cost}
        baselineCost={baselineCost}
        toonCostSavings={toonCostSavings}
        toonTokensBefore={toonTokensBefore}
        toonTokensAfter={toonTokensAfter}
        toonSkipReason={toonSkipReason}
        baselineModel={baselineModel}
        actualModel={actualModel}
        format={format}
        tooltip={tooltip}
        variant={variant}
        className={className}
      />
    );
  }

  // Billed spend is the metered portion. `derivedBilled` is null only when no
  // metered cost was recorded (SUM(cost) FILTER (billing_mode='metered') is NULL
  // over zero metered rows), i.e. a fully subscription-covered session — so
  // billed spend is $0. Falling back to the full `cost` here would re-show the
  // phantom cost this feature exists to remove.
  const billed = derivedBilled != null ? Number.parseFloat(derivedBilled) : 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`${className || ""} inline-flex items-center gap-1.5 cursor-default`}
        >
          {formatCost(billed)}
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            Subscription
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <div className="space-y-0.5 text-sm">
          <div>Billed: {formatCost(billed)}</div>
          <div className="text-muted-foreground">
            Subscription-covered (not billed): {formatCost(subscription)} est.
            at list price
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
