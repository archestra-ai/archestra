"use client";

import { TerminalSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFeature } from "@/lib/config/config.query";
import { cn } from "@/lib/utils";

const TOOLTIP =
  "Runs in a dedicated Agent Runtime. Starting it opens a live terminal instead of a chat.";

/**
 * Marks an agent that runs in a dedicated runtime, at one of two densities.
 *
 * - `glyph`: the bare terminal square, for dense pickers where the composer
 *   strip repeats the message in full one step later.
 * - `pill`: the glyph with a word, for lists and headers where nothing else
 *   is going to say it. It takes the same neutral fill as the A2A marker:
 *   both are kinds of agent, not visibility scopes, so neither borrows a
 *   scope colour.
 *
 * Rendered only while the deployment's `agentRuntime` feature is on. A stored
 * runtime config on a deployment that turned the feature off changes nothing
 * about what Chat does, so marking it would promise a terminal that never
 * opens.
 */
export function RuntimeCapableIndicator({
  variant = "glyph",
  className,
}: {
  variant?: "glyph" | "pill";
  className?: string;
}) {
  const runtimeEnabled = useFeature("agentRuntime") === true;
  if (!runtimeEnabled) return null;

  if (variant === "pill") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="secondary"
            className={cn("shrink-0 cursor-help", className)}
          >
            <TerminalSquare aria-hidden="true" />
            <span>Runtime</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top">{TOOLTIP}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex shrink-0 text-muted-foreground/60",
            className,
          )}
          role="img"
          aria-label="Dedicated runtime"
        >
          <TerminalSquare className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{TOOLTIP}</TooltipContent>
    </Tooltip>
  );
}
