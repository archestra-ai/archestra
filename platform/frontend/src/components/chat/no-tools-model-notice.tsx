import { InfoIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
        <Badge
          variant="secondary"
          className="gap-1 bg-slate-200/70 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300 px-3 py-1 text-xs font-medium cursor-default"
        >
          <InfoIcon className="size-3" />
          no tools
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-60">
        The selected model doesn&apos;t support tools, so this agent&apos;s
        tools won&apos;t be used in this chat. Switch models to use tools.
      </TooltipContent>
    </Tooltip>
  );
}
