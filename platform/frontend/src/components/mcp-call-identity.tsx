"use client";
import type { ReactNode } from "react";
import { McpToolCallStatusIcon } from "@/components/mcp-tool-call-status";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  MCP_TOOL_CALL_STATUS_LABELS,
  type McpToolCallOutcomeStatus,
} from "@/lib/mcp-logs/tool-call-content";

export function McpCallIdentity({
  name,
  server,
  icon,
  status,
  method,
}: {
  name: ReactNode;
  server: ReactNode;
  icon: ReactNode;
  status: McpToolCallOutcomeStatus;
  method: string;
}) {
  const label = MCP_TOOL_CALL_STATUS_LABELS[status];
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="relative flex size-7 shrink-0 items-center justify-center rounded bg-muted/50 text-muted-foreground">
        {icon}
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton
              aria-label={label}
              onClick={(e) => e.stopPropagation()}
              className="absolute -bottom-0.5 -right-0.5 flex size-3.5 cursor-default items-center justify-center rounded-full bg-background"
            >
              <McpToolCallStatusIcon status={status} className="size-2.5" />
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent className="px-2 py-1 text-xs">{label}</TooltipContent>
        </Tooltip>
      </span>
      <div className="min-w-0">
        <div className="truncate font-mono text-xs font-medium">{name}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{server}</span>
          {method !== "tools/call" && (
            <span className="shrink-0 text-[10px]">{method}</span>
          )}
        </div>
      </div>
    </div>
  );
}
