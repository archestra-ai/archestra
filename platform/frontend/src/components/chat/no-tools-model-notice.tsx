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
          // leading-none collapses the text's 16px line box to the glyph size
          // so it truly centers against the 12px icon; the icon glyph carries
          // ~1px of built-in inset, so the left padding is 1px tighter to
          // keep the content optically centered.
          className="gap-1 bg-slate-200/70 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300 pl-[9px] pr-2.5 py-1 text-xs font-medium leading-none cursor-default"
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
