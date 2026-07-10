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
  baselineCost,
  toonCostSavings,
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
  baselineCost: string;
  toonCostSavings?: string | null;
  format?: "percent" | "number";
  tooltip?: "never" | "always" | "hover";
  variant?: "default" | "session" | "interaction";
  className?: string;
}) {
  const subscription = subscriptionCost
    ? Number.parseFloat(subscriptionCost)
    : 0;

  if (subscription <= 0) {
    return (
      <Savings
        cost={cost}
        baselineCost={baselineCost}
        toonCostSavings={toonCostSavings}
        format={format}
        tooltip={tooltip}
        variant={variant}
        className={className}
      />
    );
  }

  const billed =
    billedCost != null ? Number.parseFloat(billedCost) : Number.parseFloat(cost);

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
            Subscription-covered (not billed): {formatCost(subscription)} est. at
            list price
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
