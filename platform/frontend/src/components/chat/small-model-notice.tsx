import { InfoIcon } from "lucide-react";
import { ComposerBadge } from "@/components/chat/composer-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Compact "small model" chip shown in the composer toolbar next to the model
 * selector when the selected model is small enough that multi-step tool use is
 * likely to be unreliable, while the selected agent brings tools. Unlike the
 * no-tools chip the turn is not guaranteed to degrade — the model may well
 * carry the loop — so the copy warns rather than states. Rendered inline in the
 * toolbar (not as a banner) so toggling models never shifts the composer
 * layout.
 */
export function SmallModelNoticeBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ComposerBadge className="cursor-default">
          <InfoIcon className="size-3" />
          small model
        </ComposerBadge>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-60">
        The selected model is small, so this agent&apos;s tools may be called
        unreliably over a multi-step task. Switch to a larger model for
        tool-heavy work.
      </TooltipContent>
    </Tooltip>
  );
}
