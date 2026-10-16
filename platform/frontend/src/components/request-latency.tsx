import { Clock3 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Compact total request time; absent on logs recorded without timing. */
export function RequestLatency({ durationMs }: { durationMs?: number | null }) {
  if (durationMs == null) return null;

  const duration =
    durationMs < 1000
      ? `${durationMs}ms`
      : `${(durationMs / 1000).toFixed(2)}s`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground"
            aria-label={`Total request latency: ${duration}`}
            role="img"
          >
            <Clock3 className="size-3" aria-hidden="true" />
            <span>{duration}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>Request duration</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
