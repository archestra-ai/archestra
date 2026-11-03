import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Marks spend that includes estimated charges: a request used tokens its
 * model has no price for, so that part of the charge was estimated.
 */
export function EstimatedSpendBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="cursor-default text-xs font-normal"
          tabIndex={0}
        >
          Includes estimates
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        This spend includes estimated prices or a frozen legacy balance.
        Recomputing past costs corrects recorded requests. Legacy balances
        without request-level accounting stay fixed until the limit resets.
      </TooltipContent>
    </Tooltip>
  );
}
