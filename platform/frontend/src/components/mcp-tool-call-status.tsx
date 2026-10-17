import {
  Check,
  CircleHelp,
  CircleStop,
  type LucideIcon,
  ShieldX,
  X,
} from "lucide-react";
import {
  MCP_TOOL_CALL_STATUS_LABELS,
  type McpToolCallOutcomeStatus,
} from "@/lib/mcp-logs/tool-call-content";
import { cn } from "@/lib/utils/tailwind";

/**
 * The glyph for how a logged MCP call ended, in its status colour. Every log
 * surface draws the outcome with these, so a blocked call reads the same in
 * the list, on the trace row and on the detail page.
 */
export function McpToolCallStatusIcon({
  status,
  className,
}: {
  status: McpToolCallOutcomeStatus;
  className?: string;
}) {
  const { icon: Icon, text } = STATUS_STYLES[status];
  return (
    <Icon
      className={cn("size-3.5 shrink-0", text, className)}
      aria-hidden="true"
    />
  );
}

/** The outcome as a dot and its label, as facts and overviews state it. */
export function McpToolCallStatusLabel({
  status,
  dotClassName = "size-2",
}: {
  status: McpToolCallOutcomeStatus;
  dotClassName?: string;
}) {
  const style = STATUS_STYLES[status];
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cn("shrink-0 rounded-full", dotClassName, style.dot)}
      />
      <span className={cn(style.label)}>
        {MCP_TOOL_CALL_STATUS_LABELS[status]}
      </span>
    </span>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

const STATUS_STYLES: Record<
  McpToolCallOutcomeStatus,
  { icon: LucideIcon; text: string; dot: string; label?: string }
> = {
  success: {
    icon: Check,
    text: "text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  error: {
    icon: X,
    text: "text-destructive",
    dot: "bg-destructive",
    label: "text-destructive",
  },
  blocked: {
    icon: ShieldX,
    text: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
    label: "text-amber-700 dark:text-amber-400",
  },
  cancelled: {
    icon: CircleStop,
    text: "text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
  unknown: {
    icon: CircleHelp,
    text: "text-muted-foreground",
    dot: "bg-muted-foreground/50",
  },
};
