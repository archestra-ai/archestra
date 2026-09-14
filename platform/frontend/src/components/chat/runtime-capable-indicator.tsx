"use client";

import { resolveAgentCatalogId } from "@archestra/shared";
import { TerminalSquare } from "lucide-react";
import {
  AGENT_CATALOG_TEMPLATE_NAMES,
  CatalogAgentIcon,
} from "@/components/agent-pages/agent-catalog-identity";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFeature } from "@/lib/config/config.query";
import { cn } from "@/lib/utils";

/**
 * Marks an agent that runs in a dedicated runtime, at one of two densities.
 *
 * - `glyph`: the bare terminal square, for dense pickers where the composer
 *   strip repeats the message in full one step later.
 * - `pill`: a mark with a word, for lists and headers where nothing else is
 *   going to say it. It takes the same neutral fill as the A2A marker: both
 *   are kinds of agent, not visibility scopes, so neither borrows a scope
 *   colour.
 *
 * When the runtime is one of the catalog's maintained CLI templates, the pill
 * shows that template's own mark and name ("Claude Code") and the tooltip
 * names it too. The mark does not stand in for the Provider column: Codex
 * can run on a non-OpenAI model, so the row still shows both. Anything else,
 * the platform's own loop included, reads as a plain "Runtime".
 *
 * Rendered only while the deployment's `agentRuntime` feature is on. A stored
 * runtime config on a deployment that turned the feature off changes nothing
 * about what Chat does, so marking it would promise a terminal that never
 * opens.
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
  const template =
    templateId && templateId !== "archestra"
      ? { id: templateId, name: AGENT_CATALOG_TEMPLATE_NAMES[templateId] }
      : null;
  const tooltip = template
    ? `Runs ${template.name} in a dedicated Agent Runtime. Starting it opens a live terminal instead of a chat.`
    : "Runs in a dedicated Agent Runtime. Starting it opens a live terminal instead of a chat.";

  if (variant === "pill") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="secondary"
            className={cn("shrink-0 cursor-help", className)}
          >
            {template ? (
              <CatalogAgentIcon id={template.id} size={12} />
            ) : (
              <TerminalSquare aria-hidden="true" />
            )}
            <span>{template?.name ?? "Runtime"}</span>
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
