import { AlertCircle } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useApplicableLimit } from "@/lib/limits.query";

export function ChatLimitProgress({ agentId }: { agentId?: string }) {
  const { data: limitInfo } = useApplicableLimit({ agentId });

  useEffect(() => {
    if (!limitInfo) return;

    const percentage = (limitInfo.usage / limitInfo.limit.limitValue) * 100;

    if (percentage >= 100) {
      toast.error("Usage Limit Reached", {
        description: `You have reached your ${limitInfo.limit.entityType} limit. Further requests will be blocked until the limit resets.`,
        duration: Infinity,
      });
    } else if (percentage >= 90) {
      toast.warning("Usage Limit Warning", {
        description: `You have used ${Math.round(percentage)}% of your ${limitInfo.limit.entityType} limit.`,
      });
    } else if (percentage >= 75) {
      toast.info("Usage Limit Notice", {
        description: `You have used ${Math.round(percentage)}% of your ${limitInfo.limit.entityType} limit.`,
      });
    }
  }, [limitInfo]);

  if (!limitInfo) return null;

  const percentage = Math.min(
    100,
    Math.max(0, (limitInfo.usage / limitInfo.limit.limitValue) * 100),
  );
  let colorClass = "bg-primary";
  if (percentage >= 90) {
    colorClass = "bg-destructive";
  } else if (percentage >= 75) {
    colorClass = "bg-orange-500";
  }

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 cursor-help px-2 border rounded-full h-7 bg-muted/20">
            <span className="text-xs font-medium text-muted-foreground whitespace-nowrap hidden sm:inline-block">
              {limitInfo.limit.entityType} limit
            </span>
            <Progress
              value={percentage}
              className="w-16 sm:w-24 h-2"
              indicatorClassName={colorClass}
            />
            {percentage >= 90 && (
              <AlertCircle className="w-3 h-3 text-destructive" />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" className="text-sm">
          <div className="space-y-1">
            <p className="font-semibold capitalize">
              {limitInfo.limit.entityType} Limit
            </p>
            <p className="text-muted-foreground text-xs">
              {limitInfo.usage.toLocaleString()} /{" "}
              {limitInfo.limit.limitValue.toLocaleString()} tokens
            </p>
            <p className="text-muted-foreground text-xs">
              Remaining: {limitInfo.remaining.toLocaleString()}
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
