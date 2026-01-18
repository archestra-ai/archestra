import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCost } from "./cost";

export interface ToonSkipReasonCounts {
  applied: number;
  notEnabled: number;
  notEffective: number;
  noToolResults: number;
}

export function Savings({
  cost,
  baselineCost,
  toonCostSavings,
  toonTokensSaved,
  toonSkipReason,
  toonSkipReasonCounts,
  format = "percent",
  tooltip = "never",
  className,
  variant = "default",
  inputTokens,
  outputTokens,
}: {
  cost: string;
  baselineCost: string;
  toonCostSavings?: string | null;
  toonTokensSaved?: number | null;
  toonSkipReason?: string | null;
  /** Aggregated skip reason counts for session view */
  toonSkipReasonCounts?: ToonSkipReasonCounts;
  format?: "percent" | "number";
  tooltip?: "never" | "always" | "hover";
  className?: string;
  variant?: "default" | "session" | "interaction";
  inputTokens?: number;
  outputTokens?: number;
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
    // Session/Interaction variants: cost with savings percentage, detailed tooltip
    if (variant === "session" || variant === "interaction") {
      const hasTokens = inputTokens !== undefined && outputTokens !== undefined;
      const isSession = variant === "session";

      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`${className || ""} cursor-default`}>
              {formatCost(actualCost)}
              {totalSavings > 0 && (
                <span className="text-green-600 dark:text-green-400">
                  {" "}
                  (-{savingsPercent}%)
                </span>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="space-y-0.5 text-sm">
              {hasTokens && (
                <div>
                  Tokens: {inputTokens.toLocaleString()} in /{" "}
                  {outputTokens.toLocaleString()} out
                </div>
              )}

              <div
                className={`${hasTokens ? "border-t border-border pt-1 mt-1" : ""} space-y-0.5`}
              >
                {totalSavings > 0 ? (
                  <>
                    <div>Estimated Cost: {formatCost(baselineCostNum)}</div>
                    <div>Actual Cost: {formatCost(actualCost)}</div>
                    <div className="font-semibold">
                      Savings: {formatCost(totalSavings)} (-{savingsPercent}%)
                    </div>
                  </>
                ) : (
                  <div>Cost: {formatCost(actualCost)}</div>
                )}
              </div>

              <div className="border-t border-border pt-1 mt-1 space-y-0.5 text-muted-foreground">
                {costOptimizationSavings > 0 ? (
                  <div>
                    Model optimization: -{formatCost(costOptimizationSavings)}
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
                ) : isSession && toonSkipReasonCounts ? (
                  (() => {
                    const hasAnyCounts =
                      toonSkipReasonCounts.applied > 0 ||
                      toonSkipReasonCounts.notEnabled > 0 ||
                      toonSkipReasonCounts.notEffective > 0 ||
                      toonSkipReasonCounts.noToolResults > 0;

                    if (!hasAnyCounts) {
                      return <div>Tool result compression: Not applied</div>;
                    }

                    return (
                      <div>
                        Tool result compression:
                        <ul className="list-disc list-inside ml-2 mt-0.5">
                          {toonSkipReasonCounts.applied > 0 && (
                            <li>
                              Applied: {toonSkipReasonCounts.applied}{" "}
                              interaction
                              {toonSkipReasonCounts.applied !== 1 ? "s" : ""}
                            </li>
                          )}
                          {toonSkipReasonCounts.notEnabled > 0 && (
                            <li>
                              Not enabled: {toonSkipReasonCounts.notEnabled}{" "}
                              interaction
                              {toonSkipReasonCounts.notEnabled !== 1 ? "s" : ""}
                            </li>
                          )}
                          {toonSkipReasonCounts.notEffective > 0 && (
                            <li>
                              Did not reduce tokens:{" "}
                              {toonSkipReasonCounts.notEffective} interaction
                              {toonSkipReasonCounts.notEffective !== 1
                                ? "s"
                                : ""}
                            </li>
                          )}
                          {toonSkipReasonCounts.noToolResults > 0 && (
                            <li>
                              No tool results:{" "}
                              {toonSkipReasonCounts.noToolResults} interaction
                              {toonSkipReasonCounts.noToolResults !== 1
                                ? "s"
                                : ""}
                            </li>
                          )}
                        </ul>
                      </div>
                    );
                  })()
                ) : isSession ? (
                  <div>Tool result compression: Not applied</div>
                ) : toonSkipReason === "not_enabled" ? (
                  <div>Tool result compression: Not enabled</div>
                ) : toonSkipReason === "not_effective" ? (
                  <div>Tool result compression: Did not reduce tokens</div>
                ) : toonSkipReason === "no_tool_results" ? (
                  <div>Tool result compression: No tool results</div>
                ) : (
                  <div>Tool result compression: Not applied</div>
                )}
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      );
    }

    // Default variant: full breakdown with baseline/actual costs
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`${colorClass} ${className || ""} cursor-default`}>
            {content}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          <div className="space-y-0.5 text-sm">
            {totalSavings > 0 && (
              <>
                <div>Estimated Cost: {formatCost(baselineCostNum)}</div>
                <div>Actual Cost: {formatCost(actualCost)}</div>
                <div className="font-semibold">
                  Savings: {formatCost(totalSavings)} (-{savingsPercent}%)
                </div>
              </>
            )}

            <div
              className={`${totalSavings > 0 ? "border-t border-border pt-1 mt-1" : ""} space-y-0.5 text-muted-foreground`}
            >
              {costOptimizationSavings > 0 ? (
                <div>
                  Model optimization: -{formatCost(costOptimizationSavings)}
                </div>
              ) : (
                <div>Model optimization: No matching rule</div>
              )}

              {toonCostSavingsNum > 0 ? (
                <div>
                  Tool results compression: -{formatCost(toonCostSavingsNum)}
                  {toonTokensSaved
                    ? ` (${toonTokensSaved.toLocaleString()} tokens saved)`
                    : ""}
                </div>
              ) : toonSkipReason === "not_enabled" ? (
                <div>Tool results compression: Not enabled</div>
              ) : toonSkipReason === "not_effective" ? (
                <div>Tool results compression: Did not reduce tokens</div>
              ) : toonSkipReason === "no_tool_results" ? (
                <div>Tool results compression: No tool results</div>
              ) : (
                <div>Tool result compression: Not applied</div>
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return <span className={`${colorClass} ${className || ""}`}>{content}</span>;
}
