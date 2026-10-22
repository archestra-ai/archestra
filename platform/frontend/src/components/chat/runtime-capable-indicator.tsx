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
import { UnstyledButton } from "@/components/ui/unstyled-button";
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
  variant?: "glyph" | "pill" | "icon";
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

  if (variant === "icon") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            aria-label={
              templateName ? `Runtime: ${templateName}` : "Dedicated runtime"
            }
            className={cn(
              "group inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
              className,
            )}
          >
            {/* Muted until hovered, so the mark reads as metadata beside the
                name rather than a second agent icon. */}
            <span className="inline-flex opacity-70 grayscale transition group-hover:opacity-100 group-hover:grayscale-0 group-focus-visible:opacity-100 group-focus-visible:grayscale-0">
              {templateId ? (
                <CatalogAgentIcon id={templateId} size={14} />
              ) : (
                <TerminalSquare className="size-3.5" aria-hidden />
              )}
            </span>
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="px-2.5 py-1">
          <span className="flex flex-col leading-snug">
            <span className="font-medium">
              {templateName ?? "Agent Runtime"}
            </span>
            <span className="text-muted-foreground">Opens a live terminal</span>
          </span>
        </TooltipContent>
      </Tooltip>
    );
  }

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
