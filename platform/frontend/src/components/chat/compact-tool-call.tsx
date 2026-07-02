"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  parseFullToolName,
  TOOL_LOAD_SKILL_SHORT_NAME,
} from "@archestra/shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { BotIcon, CheckCircleIcon, ClockIcon, WebhookIcon } from "lucide-react";
import { useState } from "react";
import {
  Tool,
  ToolContent,
  ToolErrorDetails,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getCompactToolState,
  getToolHeaderState,
} from "@/lib/chat/chat-tools-display.utils";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import { cn } from "@/lib/utils";
import { resolveRunToolTargetName } from "./chat-messages.utils";
import { HookRunChip, type HookRunChipData } from "./hook-run-chip";
import { SkillPill } from "./skill-pill";
import { ToolErrorLogsButton } from "./tool-error-logs-button";
import { ToolStatusRow } from "./tool-status-row";

type CompactToolEntry = {
  kind: "tool";
  key: string;
  toolName: string;
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  errorText: string | undefined;
  /** A delegation call's surfaced subagent tool calls, rendered between its
   * Request and Result once the circle is expanded. */
  nestedToolCalls?: React.ReactNode;
};

type CompactHookEntry = {
  kind: "hook";
  key: string;
  data: HookRunChipData;
};

type CompactEntry = CompactToolEntry | CompactHookEntry;

function CompactCircle({
  toolName,
  state,
  isExpanded,
  isExpandable = true,
  onClick,
  icon,
  catalogId,
}: {
  toolName: string;
  state: "running" | "completed" | "error";
  isExpanded: boolean;
  isExpandable?: boolean;
  onClick: () => void;
  icon?: string | null;
  catalogId?: string;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            disabled={!isExpandable}
            className={cn(
              "relative inline-flex items-center justify-center size-8 rounded-full border transition-all",
              isExpandable &&
                "hover:bg-accent hover:border-accent-foreground/20",
              !isExpandable && "cursor-default",
              isExpanded
                ? "bg-accent border-accent-foreground/20 ring-2 ring-primary/20"
                : "bg-background",
            )}
          >
            {icon || catalogId ? (
              <McpCatalogIcon icon={icon} catalogId={catalogId} size={16} />
            ) : (
              <BotIcon className="size-3.5 text-muted-foreground" />
            )}
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background",
                state === "completed" && "bg-green-500",
                state === "running" && "bg-blue-500 animate-pulse",
                state === "error" && "bg-destructive",
              )}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {parseFullToolName(toolName).toolName.replace(/_/g, " ")}
          {state === "running"
            ? " (running)"
            : state === "error"
              ? " (error)"
              : ""}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Variant of CompactCircle for `archestra__load_skill` activation calls (no
 * `path`). Same chrome as the circle (32px tall, rounded-full, bordered) but
 * the pill extends horizontally to surface the skill name inline. The pill
 * itself does NOT expand the tool-call detail card on click — only the skill
 * name navigates to the Skills list (filtered by name) and only when the user
 * has `skill:read`. A `load_skill` call with a `path` reads a bundled file from
 * an already-loaded skill; that's not a skill trigger, so it renders as a plain
 * tool circle instead of this pill (#6184).
 */
function ToolCallSkillPill({
  toolName,
  skillName,
  state,
}: {
  toolName: string;
  skillName: string | null;
  state: "running" | "completed" | "error";
}) {
  const tooltipLabel = (() => {
    const base = skillName ? `Skill: ${skillName}` : "Loading skill";
    if (state === "running") return `${base} (running)`;
    if (state === "error") return `${base} (error)`;
    return base;
  })();

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SkillPill skillName={skillName} data-tool-name={toolName}>
            {state === "running" || state === "error" ? (
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background",
                  state === "running" && "bg-blue-500 animate-pulse",
                  state === "error" && "bg-destructive",
                )}
              />
            ) : null}
          </SkillPill>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {tooltipLabel}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Compact circle for a hook run, visually matching CompactCircle: webhook icon
 * in a bordered circle with an outcome dot (green proceeded, orange blocked,
 * red error / timeout). Clicking expands the full HookRunChip card below the
 * row, exactly like a tool circle expands its tool card.
 */
function HookCircle({
  data,
  isExpanded,
  isExpandable = true,
  onClick,
}: {
  data: HookRunChipData;
  isExpanded: boolean;
  isExpandable?: boolean;
  onClick: () => void;
}) {
  const outcome = data.outcome ?? "";
  const tooltip = [
    data.hookEventName,
    data.fileName,
    outcome ? `(${outcome})` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            disabled={!isExpandable}
            className={cn(
              "relative inline-flex items-center justify-center size-8 rounded-full border transition-all",
              isExpandable &&
                "hover:bg-accent hover:border-accent-foreground/20",
              !isExpandable && "cursor-default",
              isExpanded
                ? "bg-accent border-accent-foreground/20 ring-2 ring-primary/20"
                : "bg-background",
            )}
          >
            <WebhookIcon className="size-3.5 text-muted-foreground" />
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background",
                outcome === "proceeded" && "bg-green-500",
                outcome === "blocked" && "bg-orange-500",
                (outcome === "error" || outcome === "timeout") &&
                  "bg-destructive",
              )}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export type ToolIconMap = Map<
  string,
  { icon?: string | null; catalogId?: string }
>;

export function CompactToolGroup({
  tools,
  toolIconMap,
  canExpandToolCalls = true,
  onToolApprovalResponse,
}: {
  tools: CompactEntry[];
  toolIconMap?: ToolIconMap;
  canExpandToolCalls?: boolean;
  onToolApprovalResponse?: (params: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const { isToolName, getToolShortName } = useArchestraMcpIdentity();

  const handleToggle = (key: string) => {
    if (!canExpandToolCalls) return;
    setExpandedKey((prev) => (prev === key ? null : key));
  };

  const expandedEntry = tools.find((t) => t.key === expandedKey);

  return (
    <div className="mb-4">
      <div className="flex flex-wrap gap-1.5 items-center">
        {tools.map((entry) => {
          if (entry.kind === "hook") {
            return (
              <HookCircle
                key={entry.key}
                data={entry.data}
                isExpanded={expandedKey === entry.key}
                isExpandable={canExpandToolCalls}
                onClick={() => handleToggle(entry.key)}
              />
            );
          }
          const state = getCompactToolState({
            part: entry.part,
            toolResultPart: entry.toolResultPart,
          });
          if (getToolShortName(entry.toolName) === TOOL_LOAD_SKILL_SHORT_NAME) {
            const input = (entry.part.input ?? {}) as {
              name?: unknown;
              path?: unknown;
            };
            // A `load_skill` call with a `path` reads a bundled file from an
            // already-loaded skill — a sub-action, not a new skill trigger.
            // Only activation calls (no path) get the "Skill:" pill; file reads
            // fall through to the normal tool circle below (#6184).
            const skillPath =
              typeof input.path === "string" && input.path.length > 0
                ? input.path
                : null;
            if (!skillPath) {
              const skillName =
                typeof input.name === "string" && input.name.length > 0
                  ? input.name
                  : null;
              return (
                <ToolCallSkillPill
                  key={entry.key}
                  toolName={entry.toolName}
                  skillName={skillName}
                  state={state}
                />
              );
            }
          }
          // A run_tool dispatch belongs visually to its *target* tool: unwrap
          // so the circle shows the underlying MCP server's icon (and tooltip
          // name) instead of the generic Archestra built-in icon.
          const displayToolName = resolveRunToolTargetName(
            entry.part,
            entry.toolName,
            { getToolShortName },
          );
          const iconInfo = toolIconMap?.get(displayToolName);
          const fallbackCatalogId =
            iconInfo?.catalogId ??
            (isToolName(displayToolName)
              ? ARCHESTRA_MCP_CATALOG_ID
              : undefined);
          return (
            <CompactCircle
              key={entry.key}
              toolName={displayToolName}
              state={state}
              isExpanded={expandedKey === entry.key}
              isExpandable={canExpandToolCalls}
              onClick={() => handleToggle(entry.key)}
              icon={iconInfo?.icon}
              catalogId={fallbackCatalogId}
            />
          );
        })}
      </div>
      {expandedEntry && (
        <div className="mt-2">
          {expandedEntry.kind === "hook" ? (
            <HookRunChip data={expandedEntry.data} defaultOpen />
          ) : (
            <ExpandedToolCard
              tool={expandedEntry}
              onToolApprovalResponse={onToolApprovalResponse}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ExpandedToolCard({
  tool,
  onToolApprovalResponse,
}: {
  tool: CompactToolEntry;
  onToolApprovalResponse?: (params: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
}) {
  const { part, toolResultPart, toolName, errorText, nestedToolCalls } = tool;
  const hasInput = part.input && Object.keys(part.input).length > 0;
  const isApprovalRequested = part.state === "approval-requested";

  const logsButton = errorText ? (
    <ToolErrorLogsButton toolName={toolName} />
  ) : null;
  const headerState = getToolHeaderState({
    state: part.state || "input-available",
    toolResultPart,
    errorText,
  });

  return (
    <Tool open>
      <ToolHeader
        type={`tool-${toolName}`}
        state={headerState}
        isCollapsible={false}
        actionButton={logsButton}
      />
      <ToolContent>
        {hasInput ? <ToolInput input={part.input} defaultOpen /> : null}
        {nestedToolCalls}
        {isApprovalRequested &&
          onToolApprovalResponse &&
          "approval" in part &&
          part.approval?.id && (
            <ToolStatusRow
              icon={
                <ClockIcon className="mt-0.5 size-4 flex-none text-amber-600" />
              }
              title="Approval required"
              description="Review this tool call before it can continue."
              actions={[
                {
                  label: "Approve",
                  variant: "secondary",
                  icon: <CheckCircleIcon className="size-4" />,
                  onClick: () =>
                    onToolApprovalResponse({
                      id: (part as { approval: { id: string } }).approval.id,
                      approved: true,
                    }),
                },
                {
                  label: "Decline",
                  variant: "outline",
                  onClick: () =>
                    onToolApprovalResponse({
                      id: (part as { approval: { id: string } }).approval.id,
                      approved: false,
                      reason: "User denied",
                    }),
                },
              ]}
            />
          )}
        {errorText ? <ToolErrorDetails errorText={errorText} /> : null}
        {toolResultPart && (
          <ToolOutput
            label={errorText ? "Error" : "Result"}
            output={toolResultPart.output}
            errorText={errorText}
          />
        )}
        {!toolResultPart && Boolean(part.output) && (
          <ToolOutput
            label={errorText ? "Error" : "Result"}
            output={part.output}
            errorText={errorText}
          />
        )}
      </ToolContent>
    </Tool>
  );
}
