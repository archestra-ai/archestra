"use client";

import {
  agentCatalogIdForImage,
  resolveAgentCatalogId,
  resolveAgentRuntimeTemplate,
  type TemplatedAgentRuntime,
} from "@archestra/shared";
import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { Box, Code, TerminalSquare } from "lucide-react";
import { AgentIcon } from "@/components/agent-icon";
import {
  AGENT_CATALOG_TEMPLATE_NAMES,
  CatalogAgentIcon,
  useAgentCatalogImages,
} from "@/components/agent-pages/agent-catalog";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { runtimeSettingsHref } from "@/lib/agent-runtime-settings-link";
import { useRuntimeTemplateCatalogShared } from "@/lib/agent-runtime-templates.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
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

/**
 * Names the runtime an agent was built from, for the people who administer
 * runtimes: its icon and its name, as a link to that runtime's settings. A
 * runtime's account rule can hold the accounts of every agent on it, so they
 * need to see which runtime an agent is on at a glance. Everyone else gets
 * `fallback`: the mark that spot has always shown them, or nothing.
 *
 * The name comes from the organization's runtimes, read once and shared by
 * every badge on the page: a maintained runtime's own name, a custom
 * runtime's, or "Custom image" for an image that is none of them.
 */
export function AgentRuntimeBadge({
  runtime,
  appearance = "badge",
  fallback = null,
  className,
}: {
  /** The agent's saved runtime. */
  runtime: Pick<TemplatedAgentRuntime, "image" | "command">;
  /**
   * `badge` names the runtime in a row of a list. `icon` is the quiet mark a
   * header has always had beside the agent's name, with the name in its
   * tooltip.
   */
  appearance?: "badge" | "icon";
  /** What someone who does not administer runtimes sees in this spot. */
  fallback?: "pill" | "icon" | null;
  /** For the badge alone: the fallback keeps the look it has. */
  className?: string;
}) {
  const runtimeEnabled = useFeature("agentRuntime") === true;
  const { data: administers } = useHasPermissions(RUNTIME_SETTINGS_PERMISSIONS);
  const catalogImages = useAgentCatalogImages();
  const templates = useRuntimeTemplateCatalogShared(
    runtimeEnabled && administers,
  );
  if (!runtimeEnabled) return null;
  if (!administers) {
    return fallback ? (
      <RuntimeCapableIndicator variant={fallback} runtime={runtime} />
    ) : null;
  }

  // A maintained image is its built-in runtime whatever the list holds. Any
  // other image waits for the list: only it says which custom runtime runs
  // that image, and a name that changes once it arrives would mislead.
  const maintained = agentCatalogIdForImage({
    image: runtime.image,
    catalogImages,
  });
  if (!maintained && templates.isPending) return null;
  const ref = resolveAgentRuntimeTemplate({
    runtime,
    catalogImages,
    customTemplates: templates.data ?? [],
  });
  const custom =
    ref?.kind === "custom"
      ? templates.data?.find((item) => item.id === ref.id)
      : undefined;
  const name =
    ref?.kind === "built-in"
      ? AGENT_CATALOG_TEMPLATE_NAMES[ref.id]
      : // With no list to match against, an image cannot be called custom.
        (custom?.name ?? (templates.isError ? "Runtime" : "Custom image"));
  const label = ref
    ? `Runtime: ${name}, open its settings`
    : `Runtime: ${name}, open runtime settings`;
  const mark = (size: number) =>
    ref?.kind === "built-in" ? (
      <CatalogAgentIcon id={ref.id} size={size} />
    ) : custom?.icon ? (
      <AgentIcon icon={custom.icon} size={size} />
    ) : custom ? (
      <Box />
    ) : templates.isError ? (
      <TerminalSquare />
    ) : (
      <Code />
    );
  const hint = (
    <TooltipContent side="bottom" className="px-2.5 py-1">
      <span className="flex flex-col leading-snug">
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground">
          {ref ? "Open this runtime's settings" : "None of your runtimes"}
        </span>
      </span>
    </TooltipContent>
  );

  if (appearance === "icon") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <IntentPrefetchLink
            href={runtimeSettingsHref(ref?.id)}
            aria-label={label}
            // The look of the header's runtime mark: muted until hovered, so
            // it reads as metadata beside the name.
            className={cn(
              "group inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
              className,
            )}
          >
            <span
              aria-hidden="true"
              className="inline-flex opacity-70 grayscale transition group-hover:opacity-100 group-hover:grayscale-0 group-focus-visible:opacity-100 group-focus-visible:grayscale-0 [&>svg]:size-3.5"
            >
              {mark(14)}
            </span>
          </IntentPrefetchLink>
        </TooltipTrigger>
        {hint}
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          asChild
          variant="secondary"
          // Beside an agent's name the name comes first: the badge asks for
          // little room and takes what the row has left, up to its own
          // width. In a narrow row its name is cut short instead of the
          // agent's, and it does not wrap out of sight.
          className={cn("max-w-max grow basis-14", className)}
        >
          <IntentPrefetchLink
            href={runtimeSettingsHref(ref?.id)}
            aria-label={label}
          >
            {/* The mark keeps its size where the name has to give way. */}
            <span
              aria-hidden="true"
              className="flex shrink-0 items-center [&>svg]:size-3"
            >
              {mark(12)}
            </span>
            {/* A long custom name is cut here, and sooner where the badge
                itself has less room; the tooltip holds all of it. */}
            <span className="min-w-0 max-w-32 truncate">{name}</span>
          </IntentPrefetchLink>
        </Badge>
      </TooltipTrigger>
      {hint}
    </Tooltip>
  );
}

/**
 * Compact, non-interactive runtime indicator for pills, cards, and dense rows
 * (such as assigned subagent cards and load-balancing weight rows).
 * Renders whenever an agent has a saved `runtime` object — even when the
 * cluster's Agent Runtime feature is currently off — so people can tell at a
 * glance which assigned agents run in an Agent Runtime and which runtime they
 * use. Safe inside interactive triggers like `<Button>`.
 */
export function AgentRuntimeChip({
  runtime,
  appearance = "chip",
  className,
}: {
  /** The agent's saved runtime config, or null/undefined for a regular agent. */
  runtime: unknown;
  /**
   * `chip` shows the runtime icon and name (for popovers and wider rows).
   * `icon` shows just the runtime mark with a tooltip naming it, matching the
   * agent details page header (for compact cards and pills).
   */
  appearance?: "chip" | "icon";
  className?: string;
}) {
  const runtimeObj =
    runtime && typeof runtime === "object"
      ? (runtime as { image?: unknown; command?: unknown })
      : null;
  const image = typeof runtimeObj?.image === "string" ? runtimeObj.image : "";
  const command = Array.isArray(runtimeObj?.command)
    ? runtimeObj.command.filter(
        (item): item is string => typeof item === "string",
      )
    : null;
  const catalogImages = useAgentCatalogImages();
  const builtInId = runtimeObj
    ? (resolveAgentCatalogId(runtimeObj) ??
      (image ? agentCatalogIdForImage({ image, catalogImages }) : null))
    : null;
  const runtimeEnabled = useFeature("agentRuntime") === true;
  const administers =
    useHasPermissions(RUNTIME_SETTINGS_PERMISSIONS)?.data === true;
  const templates = useRuntimeTemplateCatalogShared(
    Boolean(runtimeObj) && !builtInId && runtimeEnabled && administers,
  );

  if (!runtimeObj) return null;

  const customTemplates = templates?.data ?? [];
  const ref =
    !builtInId && image
      ? resolveAgentRuntimeTemplate({
          runtime: { image, command },
          catalogImages,
          customTemplates,
        })
      : null;
  const custom =
    ref?.kind === "custom"
      ? customTemplates.find((item) => item.id === ref.id)
      : undefined;
  const resolvedBuiltInId =
    builtInId ?? (ref?.kind === "built-in" ? ref.id : null);
  const name = resolvedBuiltInId
    ? AGENT_CATALOG_TEMPLATE_NAMES[resolvedBuiltInId]
    : (custom?.name ?? (image ? "Custom image" : "Runtime"));
  const iconSize = appearance === "icon" ? 14 : 12;
  const fallbackIconClass = appearance === "icon" ? "size-3.5" : "size-3";
  const mark = resolvedBuiltInId ? (
    <CatalogAgentIcon id={resolvedBuiltInId} size={iconSize} />
  ) : custom?.icon ? (
    <AgentIcon icon={custom.icon} size={iconSize} />
  ) : custom ? (
    <Box className={fallbackIconClass} aria-hidden="true" />
  ) : (
    <TerminalSquare className={fallbackIconClass} aria-hidden="true" />
  );

  if (appearance === "icon") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={`Agent Runtime: ${name}`}
            className={cn(
              // Match the agent details page header runtime icon: muted until
              // the card is hovered or focused so it reads as metadata beside
              // the agent name rather than competing with the agent icon.
              "inline-flex shrink-0 items-center justify-center text-muted-foreground opacity-70 grayscale transition group-hover:opacity-100 group-hover:grayscale-0 group-focus-visible:opacity-100 group-focus-visible:grayscale-0",
              className,
            )}
          >
            {mark}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="px-2.5 py-1">
          <span className="flex flex-col leading-snug">
            <span className="font-medium">{name}</span>
            <span className="text-muted-foreground">Agent Runtime</span>
          </span>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <span
      title={`Agent Runtime: ${name}`}
      className={cn(
        "inline-flex min-w-0 shrink-0 items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium leading-none text-secondary-foreground",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="inline-flex shrink-0 items-center [&>svg]:size-3"
      >
        {mark}
      </span>
      <span className="max-w-28 truncate">{name}</span>
    </span>
  );
}

/** What opens Settings → Agents → Runtimes: that page's own permission. */
const RUNTIME_SETTINGS_PERMISSIONS =
  requiredPagePermissionsMap["/settings/agents/runtimes"];
