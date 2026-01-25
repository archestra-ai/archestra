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
  toonSkipReason,
  format = "percent",
  tooltip = "never",
  className,
  variant = "default",
  baselineModel,
  actualModel,
}: {
  cost: string;
  baselineCost: string;
  toonCostSavings?: string | null;
  toonTokensSaved?: number | null;
  toonSkipReason?: string | null;
  format?: "percent" | "number";
  tooltip?: "never" | "always" | "hover";
  className?: string;
  variant?: "default" | "session" | "interaction";
  /** The original requested model before cost optimization */
  baselineModel?: string | null;
  /** The actual model used after cost optimization */
  actualModel?: string | null;
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
    const isSession = variant === "session";

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`${className || ""} cursor-default`}>
            {formatCost(actualCost)}
            {savingsPercentNum >= 0.05 && (
              <span className="text-green-600 dark:text-green-400">
                {" "}
                (-{savingsPercent}%)
              </span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="space-y-0.5 text-sm">
            <div className="space-y-0.5">
              {totalSavings > 0 ? (
                <>
                  <div>Estimated Cost: {formatCost(baselineCostNum)}</div>
                  <div>Actual Cost: {formatCost(actualCost)}</div>
                  <div className="font-semibold">
                    Savings: {formatCost(totalSavings)}
                    {savingsPercentNum >= 0.05 && ` (-${savingsPercent}%)`}
                  </div>
                </>
              ) : (
                <div>Cost: {formatCost(actualCost)}</div>
              )}
            </div>

            {isSession ? (
              <div className="border-t border-border pt-1 mt-1 text-muted-foreground">
                Check session logs to see the cost and savings breakdown.
              </div>
            ) : (
              <div className="border-t border-border pt-1 mt-1 space-y-0.5 text-muted-foreground">
                {costOptimizationSavings > 0 ? (
                  <div>
                    Model optimization: -{formatCost(costOptimizationSavings)}
                    {baselineModel &&
                    actualModel &&
                    baselineModel !== actualModel
                      ? ` (${baselineModel} \u2192 ${actualModel})`
                      : ""}
                  </div>
                ) : (
                  <div>Model optimization: No matching rule</div>
                )}

                {toonCostSavingsNum > 0 ? (
                  <div>
                    Tool result compression: -{formatCost(toonCostSavingsNum)}
                    {toonTokensSaved
                      ? ` (${toonTokensSaved.toLocaleString()} tokens saved)`
                      : ""}
                  </div>
                ) : toonSkipReason === "not_enabled" ? (
                  <div>Tool result compression: Not enabled</div>
                ) : toonSkipReason === "not_effective" ? (
                  <div>Tool result compression: Skipped (no token savings)</div>
                ) : toonSkipReason === "no_tool_results" ? (
                  <div>Tool result compression: No tool results</div>
                ) : (
                  <div>Tool result compression: Not applied</div>
                )}
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return <span className={`${colorClass} ${className || ""}`}>{content}</span>;
}
