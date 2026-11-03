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
        Part of this spend is estimated: some requests used tokens their model
        has no price for. Set the model's prices under Models, then recompute
        its past costs.
      </TooltipContent>
    </Tooltip>
  );
}
