"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
} from "@archestra/shared";
import { AppWindow } from "lucide-react";
import type { ReactNode } from "react";
import { AgentIdenticon } from "@/app/llm/logs/_parts/hue-avatar";
import { sourceLabel } from "@/app/llm/logs/_parts/logs-table-format";
import { McpCallChip } from "@/app/llm/logs/[id]/_parts/request-waterfall";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { SourceIcon } from "@/components/source-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  formatAuthMethod,
  formatCallerIdentity,
} from "@/lib/mcp/mcp-tool-call.query";
import type { McpServerDisplay } from "@/lib/mcp-logs/use-mcp-server-display";
import { cn } from "@/lib/utils/tailwind";

type McpToolCallRecord = archestraApiTypes.GetMcpToolCallResponses["200"];

/** The server's mark for the page's icon tile; its initial when it has none. */
export function ToolCallHeaderIcon({
  display,
}: {
  display: McpServerDisplay | undefined;
}) {
  const hasMark =
    Boolean(display?.icon) || display?.catalogId === ARCHESTRA_MCP_CATALOG_ID;
  if (hasMark || !display) {
    return (
      <McpCatalogIcon
        icon={display?.icon}
        catalogId={display?.catalogId}
        size={24}
      />
    );
  }
  return (
    <span className="flex items-center justify-center font-sans text-lg font-semibold text-foreground/80">
      {display.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * What was called. A protocol method (`initialize`, `tools/list`) is named by
 * the method and says so.
 */
export function ToolCallHeaderTitle({
  title,
  method,
}: {
  title: string;
  method: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span className="min-w-0 truncate font-mono" title={title}>
        {title}
      </span>
      {method === "tools/call" ? null : <McpCallChip method={method} />}
    </span>
  );
}

/**
 * "Priya Raman via OAuth" then "GitHub · My Gateway", under the title text.
 * Who made the call and where it went are two units: on a phone each takes
 * its own line, and wider they share one, so a wrap never strands a lone item
 * or a dot.
 */
export function ToolCallIdentityLine({
  call,
  display,
  agentName,
}: {
  call: McpToolCallRecord;
  display: McpServerDisplay | undefined;
  agentName: string | undefined;
}) {
  const actor = describeCaller(call);
  const via =
    call.source === "chat"
      ? sourceLabel("chat")
      : formatAuthMethod(call.authMethod);

  // Each group leads with its own separator; the row is pulled left by one
  // separator's width and clipped, so the dot that would start a line is
  // hidden instead of dangling there.
  return (
    <div className="min-w-0">
      <div className="-my-0.5 overflow-hidden py-0.5">
        <div className="-ml-6 flex flex-wrap items-center gap-y-1 text-sm text-muted-foreground">
          <IdentityGroup>
            <span className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap">
              {actor.explanation ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <UnstyledButton className="inline-flex cursor-default items-center underline decoration-muted-foreground/50 decoration-dotted underline-offset-4">
                      {actor.label}
                    </UnstyledButton>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {actor.explanation}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className="truncate font-medium text-foreground">
                  {actor.label}
                </span>
              )}
              <span className="text-muted-foreground/70">via</span>
              <span className="inline-flex items-center gap-1 text-foreground/80 [&_svg]:size-3.5">
                {call.source === "chat" ? <SourceIcon source="chat" /> : null}
                <span>{via}</span>
              </span>
            </span>
          </IdentityGroup>
          <IdentityGroup className="max-sm:w-full">
            <span
              className="inline-flex min-w-0 shrink items-center gap-1.5 whitespace-nowrap"
              title={call.mcpServerName}
            >
              <McpCatalogIcon
                icon={display?.icon}
                catalogId={display?.catalogId}
                size={14}
              />
              <span className="truncate">
                {display?.name ?? (
                  <span className="font-mono text-xs">
                    {call.mcpServerName}
                  </span>
                )}
              </span>
            </span>
            <Separator />
            <OwnerLabel call={call} agentName={agentName} />
          </IdentityGroup>
        </div>
      </div>
    </div>
  );
}

/** The gateway or app that owns the call, with its mark. */
export function OwnerLabel({
  call,
  agentName,
}: {
  call: McpToolCallRecord;
  agentName: string | undefined;
}) {
  return call.ownerType === "app" ? (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      <AppWindow className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
      <span className="sr-only">App:</span>
      <span className="truncate">{call.appName ?? "Deleted App"}</span>
    </span>
  ) : (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      <AgentIdenticon
        seed={call.agentId ?? "deleted"}
        name={agentName ?? "MCP Gateway"}
        variant={call.agentId === null ? "deleted" : "agent"}
        size="sm"
      />
      <span className="sr-only">MCP Gateway:</span>
      <span className="truncate">
        {agentName ??
          (call.agentId === null ? "Deleted MCP Gateway" : "Unknown")}
      </span>
    </span>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function IdentityGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center", className)}>
      <Separator />
      {children}
    </span>
  );
}

function Separator() {
  return (
    <span
      aria-hidden="true"
      className="w-6 shrink-0 text-center text-muted-foreground/50"
    >
      ·
    </span>
  );
}

/** Who made the call, or the token that stands in for nobody. */
function describeCaller(call: McpToolCallRecord): {
  label: string;
  explanation: string | null;
} {
  const caller = formatCallerIdentity(call);
  if (caller?.name) return { label: caller.name, explanation: null };
  if (caller?.scope === "org") {
    return {
      label: "Organization",
      explanation:
        "Made with an organization token, which acts for the organization rather than a person.",
    };
  }
  if (caller?.scope === "team") {
    return {
      label: "Team",
      explanation:
        "Made with a team token, which acts for its team rather than a person.",
    };
  }
  return {
    label: "Unattributed",
    explanation: "No user was recorded for this call.",
  };
}
