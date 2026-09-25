"use client";

import { resolveAgentCatalogId } from "@archestra/shared";
import { TerminalSquare } from "lucide-react";
import {
  AGENT_CATALOG_TEMPLATE_NAMES,
  CatalogAgentIcon,
} from "@/components/agent-pages/agent-catalog";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFeature } from "@/lib/config/config.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * Marks an agent with a dedicated runtime: `glyph` for dense pickers, `pill`
 * (mark and name, "Claude Code" for a catalog template) for lists and headers.
 * Renders nothing while `agentRuntime` is off, matching the composer.
 */
export function RuntimeCapableIndicator({
  variant = "glyph",
  runtime,
  className,
}: {
  variant?: "glyph" | "pill";
  /** The agent's saved runtime config, to name its template when it has one. */
  runtime?: unknown;
  className?: string;
}) {
  const runtimeEnabled = useFeature("agentRuntime") === true;
  if (!runtimeEnabled) return null;

  const templateId = resolveAgentCatalogId(runtime);
  const templateName = templateId
    ? AGENT_CATALOG_TEMPLATE_NAMES[templateId]
    : null;
  const tooltip = `Runs ${templateName ? `${templateName} ` : ""}in a dedicated Agent Runtime. Starting it opens a live terminal instead of a chat.`;

  if (variant === "pill") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="secondary"
            className={cn("shrink-0 cursor-help", className)}
          >
            {templateId ? (
              <CatalogAgentIcon id={templateId} size={12} />
            ) : (
              <TerminalSquare aria-hidden="true" />
            )}
            <span>{templateName ?? "Runtime"}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
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
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
