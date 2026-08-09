import { InfoIcon } from "lucide-react";
import { ComposerBadge } from "@/components/chat/composer-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Compact chip shown in the composer toolbar next to the model selector when
 * the sync judged the selected model a poor fit for agent work while the
 * selected agent brings tools. Unlike the no-tools chip the turn is not
 * guaranteed to degrade — the model may well carry the loop — so the copy
 * advises rather than states. Rendered inline in the toolbar (not as a banner)
 * so toggling models never shifts the composer layout.
 */
export function NotRecommendedForAgentsNoticeBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ComposerBadge className="cursor-default">
          <InfoIcon className="size-3" />
          Limited for complex tasks
        </ComposerBadge>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-60">
        This model works best for simple questions and chat. For complex work,
        switch to a more capable model.
      </TooltipContent>
    </Tooltip>
  );
}
