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
  format = "percent",
  tooltip = "never",
  className,
}: {
  cost: string;
  baselineCost: string;
  format?: "percent" | "number";
  tooltip?: "never" | "always" | "hover";
  className?: string;
}) {
  const costNum = Number.parseFloat(cost);
  const baselineCostNum = Number.parseFloat(baselineCost);
  const savings = baselineCostNum - costNum;
  const savingsPercentNum =
    baselineCostNum > 0 ? (savings / baselineCostNum) * 100 : 0;
  const savingsPercent =
    savingsPercentNum % 1 === 0
      ? savingsPercentNum.toFixed(0)
      : savingsPercentNum.toFixed(1);

  const colorClass =
    savings === 0
      ? "text-muted-foreground"
      : savings > 0
        ? "text-green-600 dark:text-green-400"
        : "text-red-600 dark:text-red-400";

  let content = null;
  if (format === "percent") {
    content = savings > 0 ? `+${savingsPercent}%` : `${savingsPercent}%`;
  } else if (format === "number") {
    content = savings === 0 ? "$0" : formatCost(Math.abs(savings));
  }

  if (tooltip !== "never") {
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
            <div className="space-y-2">
              {savings === 0 ? (
                <div className={colorClass}>No cost optimization possible</div>
              ) : (
                <>
                  <div>Baseline: {formatCost(baselineCostNum)}</div>
                  <div className={colorClass}>
                    Savings: {formatCost(Math.abs(savings))} (
                    {savings > 0 ? `+${savingsPercent}%` : `${savingsPercent}%`}
                    )
                  </div>
                </>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return <span className={`${colorClass} ${className || ""}`}>{content}</span>;
}
