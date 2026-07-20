import { InfoIcon } from "lucide-react";
import { ComposerBadge } from "@/components/chat/composer-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Compact "no tools" chip shown in the composer toolbar next to the model
 * selector when the selected model can't take tools while the selected agent
 * has some: the turn runs tool-less (the backend omits tools for such models),
 * which the user should learn before sending, not from tools silently never
 * firing. Rendered inline in the toolbar (not as a banner) so toggling models
 * never shifts the composer layout.
 */
export function NoToolsModelBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ComposerBadge className="cursor-default">
          <InfoIcon className="size-3" />
          no tools
        </ComposerBadge>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-60">
        The selected model doesn&apos;t support tools, so this agent&apos;s
        tools won&apos;t be used in this chat. Switch models to use tools.
      </TooltipContent>
    </Tooltip>
  );
}
