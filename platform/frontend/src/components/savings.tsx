import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCost } from "./cost";

export function Savings({
  cost,
  baselineCost,
  toonCostSavings,
  toonTokensSaved,
  format = "percent",
  tooltip = "never",
  className,
  showUnifiedTooltip = false,
}: {
  cost: string;
  baselineCost: string;
  toonCostSavings?: string | null;
  toonTokensSaved?: number | null;
  format?: "percent" | "number";
  tooltip?: "never" | "always" | "hover";
  className?: string;
  showUnifiedTooltip?: boolean;
}) {
  const costNum = Number.parseFloat(cost);
  const baselineCostNum = Number.parseFloat(baselineCost);
  const toonCostSavingsNum = toonCostSavings
    ? Number.parseFloat(toonCostSavings)
    : 0;

  // Calculate cost optimization savings (from model selection)
  const costOptimizationSavings = baselineCostNum - costNum;

  // Calculate total savings (cost optimization + TOON compression)
  const totalSavings = costOptimizationSavings + toonCostSavingsNum;

  // Calculate actual cost after all savings
  const actualCost = baselineCostNum - totalSavings;

  const savingsPercentNum =
    baselineCostNum > 0 ? (totalSavings / baselineCostNum) * 100 : 0;
  const savingsPercent =
    savingsPercentNum % 1 === 0
      ? savingsPercentNum.toFixed(0)
      : savingsPercentNum.toFixed(1);

  const colorClass =
    totalSavings === 0
      ? "text-muted-foreground"
      : totalSavings > 0
        ? "text-green-600 dark:text-green-400"
        : "text-red-600 dark:text-red-400";

  let content = null;
  if (format === "percent") {
    content = totalSavings > 0 ? `-${savingsPercent}%` : `${savingsPercent}%`;
  } else if (format === "number") {
    content = totalSavings === 0 ? "$0" : formatCost(Math.abs(totalSavings));
  }

  if (tooltip !== "never") {
    // Check if this is a unified view (explicitly set or has TOON data) or simple view
    const isUnifiedView =
      showUnifiedTooltip ||
      (toonCostSavings !== undefined && toonCostSavings !== null);

    return (
      <div
        className={`${className || ""} inline-flex items-center gap-1 group`}
      >
        <span className={colorClass}>{content}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Info
              className={`h-4 w-4 text-muted-foreground/50 ${
                tooltip === "hover"
                  ? "opacity-0 group-hover:opacity-100 transition-opacity"
                  : ""
              }`}
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {isUnifiedView ? (
              // UCS (Unified Cost Savings) tooltip format
              <div className="space-y-0.5 text-sm">
                {totalSavings === 0 ? (
                  <div className={colorClass}>No cost savings available</div>
                ) : (
                  <>
                    <div>Baseline Cost: {formatCost(baselineCostNum)}</div>
                    <div>Actual Cost: {formatCost(actualCost)}</div>
                    <div className="font-semibold">
                      Savings: {formatCost(totalSavings)} (-
                      {savingsPercent}%)
                    </div>

                    <div className="border-t border-border pt-1 mt-1 space-y-0.5 text-muted-foreground">
                      {costOptimizationSavings > 0 && (
                        <div>
                          <div>Model cost optimization:</div>
                          <div>-{formatCost(costOptimizationSavings)}</div>
                        </div>
                      )}

                      {toonCostSavingsNum > 0 && toonTokensSaved && (
                        <div>
                          <div>Tool result compression:</div>
                          <div>
                            -{formatCost(toonCostSavingsNum)} (
                            {toonTokensSaved.toLocaleString()} tokens saved)
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : (
              // Original simple tooltip format (for Cost Savings column)
              <div className="space-y-2">
                {totalSavings === 0 ? (
                  <div className={colorClass}>
                    No cost optimization possible
                  </div>
                ) : (
                  <>
                    <div>Baseline: {formatCost(baselineCostNum)}</div>
                    <div className={colorClass}>
                      Savings: {formatCost(Math.abs(totalSavings))} (
                      {totalSavings > 0
                        ? `-${savingsPercent}%`
                        : `${savingsPercent}%`}
                      )
                    </div>
                  </>
                )}
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return <span className={`${colorClass} ${className || ""}`}>{content}</span>;
}
