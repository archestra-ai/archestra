import { InlineTag } from "@/components/ui/inline-tag";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Marks the signed-in user's personal default agent in a list. Deliberately a
 * tier below the scope pill beside it: it is an attribute of the row for this
 * viewer, not a classification of the agent — the same muted, borderless tag
 * the model lists use for "default".
 */
export function PersonalDefaultAgentTag() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <InlineTag className="text-muted-foreground bg-muted cursor-help">
            default
          </InlineTag>
        </TooltipTrigger>
        <TooltipContent>
          Your default agent — preselected when you start a new chat.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
