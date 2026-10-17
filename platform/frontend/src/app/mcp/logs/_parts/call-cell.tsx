"use client";

import {
  isEncryptedChatUnavailableContent,
  isLogContentNotStored,
  parseFullToolName,
} from "@archestra/shared";
import { Bot, Globe, type LucideIcon, Users, UserX } from "lucide-react";
import { PersonAvatar } from "@/app/llm/logs/_parts/hue-avatar";
import { EncryptedChatContentUnavailableLabel } from "@/components/encrypted-chat-content-unavailable";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  canShowMcpToolCallStatus,
  resolveMcpToolCallStatus,
} from "@/lib/mcp-logs/tool-call-status";
import { cn } from "@/lib/utils/tailwind";
import type { McpServerDisplay, McpToolCallRow } from "./types";

/**
 * What was called and who called it: the server's tile with the caller pinned
 * to its corner, then the tool over "Priya Raman on GitHub". A failure tags
 * the tool and puts the error text on the second line.
 */
export function CallCell({
  row,
  server,
}: {
  row: McpToolCallRow;
  server: McpServerDisplay | undefined;
}) {
  const method = row.method || "tools/call";
  const call = row.toolCall;
  const locked = isEncryptedChatUnavailableContent(call);
  const fullName = !locked && call && "name" in call ? call.name : undefined;
  const toolName = fullName
    ? parseFullToolName(fullName).toolName || fullName
    : null;
  const serverName = server?.name ?? (row.mcpServerName || "Platform");
  const status = statusOf(row, method);
  const errorText = status === "error" ? errorMessageOf(row.toolResult) : null;
  const caller = describeCaller(row);

  return (
    <div className="flex min-w-0 items-center gap-3.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            aria-label={`${caller.label} on ${serverName}`}
            className="relative block size-9 shrink-0 cursor-default"
          >
            <span className="flex size-9 items-center justify-center rounded-[9px] border border-border/70 bg-gradient-to-b from-background to-muted/70 text-foreground/70">
              <McpCatalogIcon
                icon={server?.icon}
                catalogId={server?.catalogId}
                size={16}
              />
            </span>
            <span className="absolute -right-1.5 -bottom-1.5 flex">
              <CallerBadge caller={caller} />
            </span>
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs px-2.5 py-2">
          <div className="mb-1.5 text-muted-foreground">On {serverName}</div>
          <div className="flex items-center gap-1.5">
            <CallerBadge caller={caller} ring={false} />
            <span>{caller.label}</span>
          </div>
          {caller.explanation ? (
            <p className="mt-1.5 leading-snug text-muted-foreground">
              {caller.explanation}
            </p>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <div className="flex h-5 min-w-0 items-center gap-2">
          {locked ? (
            <EncryptedChatContentUnavailableLabel value={call} />
          ) : (
            <span
              className="truncate text-sm leading-5 font-medium"
              title={fullName ?? undefined}
            >
              {toolName ?? formatMcpMethod(method)}
            </span>
          )}
          {status === "error" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <UnstyledButton className="shrink-0 cursor-default rounded-sm bg-destructive/10 px-1 text-[10px] leading-4 font-medium tracking-wide text-destructive uppercase">
                  Failed
                </UnstyledButton>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs px-2 py-1.5">
                <div className="mb-0.5 text-muted-foreground">Error</div>
                <p className="font-mono text-[11px] leading-snug">
                  {errorText ?? "The tool returned an error."}
                </p>
              </TooltipContent>
            </Tooltip>
          ) : status === "cancelled" ? (
            <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] leading-4 font-medium tracking-wide text-muted-foreground uppercase">
              Cancelled
            </span>
          ) : null}
        </div>
        {/* One inline run that truncates as a whole, so a narrow column cuts
            the line short instead of pushing it into the next cell. */}
        <div className="h-4 truncate text-xs leading-4 text-muted-foreground">
          <span
            className={cn(caller.kind === "person" && "text-foreground/80")}
          >
            {caller.label}
          </span>{" "}
          <span className="text-muted-foreground/70">on</span> {serverName}
          {row.source === "chat" ? (
            <>
              {" "}
              <Dot /> Chat
            </>
          ) : null}
          {errorText ? (
            <>
              {" "}
              <Dot /> <span className="text-destructive/80">{errorText}</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

type Caller =
  | { kind: "person"; label: string; explanation?: string }
  | { kind: "token"; icon: LucideIcon; label: string; explanation: string };

function CallerBadge({
  caller,
  ring = true,
}: {
  caller: Caller;
  ring?: boolean;
}) {
  if (caller.kind === "person") {
    return <PersonAvatar name={caller.label} size={18} ring={ring} />;
  }
  const Icon = caller.icon;
  return (
    <span
      className={cn(
        "flex size-[18px] items-center justify-center rounded-full bg-muted text-muted-foreground",
        ring && "ring-2 ring-background",
      )}
    >
      <Icon className="size-2.5" strokeWidth={2.25} aria-hidden="true" />
    </span>
  );
}

function describeCaller(row: McpToolCallRow): Caller {
  if (row.userName) return { kind: "person", label: row.userName };
  switch (row.authMethod) {
    case "team_token":
      return {
        kind: "token",
        icon: Users,
        label: "Team token",
        explanation:
          "A team-scoped gateway token made this call. It acts for the team, not a person.",
      };
    case "org_token":
      return {
        kind: "token",
        icon: Globe,
        label: "Org token",
        explanation:
          "An organization-scoped gateway token made this call. It acts for the organization, not a person.",
      };
    case "service_account_token":
      return {
        kind: "token",
        icon: Bot,
        label: "Service account",
        explanation: "A service account's token made this call.",
      };
    default:
      return {
        kind: "token",
        icon: UserX,
        label: "Unattributed",
        explanation: "No user is attached to this call.",
      };
  }
}

function statusOf(
  row: McpToolCallRow,
  method: string,
): "success" | "error" | "cancelled" | "unknown" {
  const result = row.toolResult;
  if (
    isEncryptedChatUnavailableContent(result) &&
    !canShowMcpToolCallStatus(method, result)
  ) {
    return "unknown";
  }
  return method === "tools/call" ? resolveMcpToolCallStatus(result) : "success";
}

function errorMessageOf(result: unknown): string | null {
  if (isLogContentNotStored(result)) return null;
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const text = (part as { text?: unknown } | null)?.text;
    if (typeof text === "string" && text) return text;
  }
  return null;
}

function formatMcpMethod(method: string) {
  if (method === "initialize") return "Initialize";
  if (method === "tools/list") return "List tools";
  if (method === "tools/call") return "Tool call";
  return method;
}

function Dot() {
  return (
    <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">
      ·
    </span>
  );
}
