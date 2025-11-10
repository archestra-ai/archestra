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
  format = "both",
  showTooltip = false,
  className,
}: {
  cost: string;
  baselineCost: string;
  format?: "percent" | "number" | "both";
  showTooltip?: boolean;
  className?: string;
}) {
  const costNum = Number.parseFloat(cost);
  const baselineCostNum = Number.parseFloat(baselineCost);
  const savings = baselineCostNum - costNum;
  const savingsPercent =
    baselineCostNum > 0
      ? ((savings / baselineCostNum) * 100).toFixed(1)
      : "0.0";

  const colorClass =
    savings === 0
      ? "text-muted-foreground"
      : savings > 0
        ? "text-green-600 dark:text-green-400"
        : "text-red-600 dark:text-red-400";

  const content = (
    <>
      {format === "percent" && (
        <>{savings > 0 ? `+${savingsPercent}%` : `${savingsPercent}%`}</>
      )}
      {format === "number" && <>{formatCost(savings)}</>}
      {format === "both" && (
        <>
          {formatCost(savings)} (
          {savings > 0 ? `+${savingsPercent}%` : `${savingsPercent}%`})
        </>
      )}
    </>
  );

  if (showTooltip) {
    return (
      <div className={`${className || ""} inline-flex items-center gap-1`}>
        <span className={colorClass}>{content}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="h-4 w-4 text-muted-foreground/50" />
          </TooltipTrigger>
          <TooltipContent>
            <div className="space-y-1">
              <div>Baseline: {formatCost(baselineCostNum)}</div>
              <div className={colorClass}>
                Savings: {formatCost(savings)} (
                {savings > 0 ? `+${savingsPercent}%` : `${savingsPercent}%`})
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return <span className={`${colorClass} ${className || ""}`}>{content}</span>;
}
