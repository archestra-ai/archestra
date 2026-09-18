import { TerminalSquare } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ATTENTION_DOT_CLASS,
  GLYPH_CLASS,
  type RunStatusInput,
  runStatusMarks,
} from "@/lib/agent-run-status-marks";
import { cn } from "@/lib/utils";

export function RunStateIcon({
  className,
  ...run
}: RunStatusInput & { className?: string }) {
  const marks = runStatusMarks(run);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={marks.description}
          className={cn("relative inline-flex shrink-0", className)}
        >
          <TerminalSquare
            aria-hidden
            className={cn("size-full", GLYPH_CLASS[marks.glyph].text)}
          />
          {marks.dot && (
            <span
              aria-hidden
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-sidebar",
                ATTENTION_DOT_CLASS[marks.dot],
              )}
            />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={5}>
        <span>{marks.description}</span>
      </TooltipContent>
    </Tooltip>
  );
}
