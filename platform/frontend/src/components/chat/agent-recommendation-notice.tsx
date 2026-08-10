import { InfoIcon } from "lucide-react";
import { ComposerBadge } from "@/components/chat/composer-badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Compact chip shown in the composer toolbar next to the model selector when
 * the sync judged the selected model a poor fit for agent work while the
 * selected agent brings tools. Unlike the no-tools chip the turn is not
 * guaranteed to degrade — the model may well carry the loop — so the copy
 * advises rather than states. Rendered inline in the toolbar (not as a banner)
 * so toggling models never shifts the composer layout.
 *
 * The guidance opens from a click/tap/Enter Popover on a real button rather
 * than a hover Tooltip: a hover-only overlay on a non-focusable span is
 * unreachable by keyboard and unreliable on touch.
 */
export function NotRecommendedForAgentsNoticeBadge() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <ComposerBadge asChild className="cursor-pointer">
          <button type="button">
            <InfoIcon className="size-3" />
            Limited for complex tasks
          </button>
        </ComposerBadge>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        sideOffset={4}
        className="w-auto max-w-60 p-3 text-xs"
      >
        This model works best for simple questions and chat. For complex work,
        switch to a more capable model.
      </PopoverContent>
    </Popover>
  );
}
