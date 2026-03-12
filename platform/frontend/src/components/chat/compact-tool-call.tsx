"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { BotIcon } from "lucide-react";
import { useState } from "react";
import { McpCatalogIcon } from "@/components/agent-tools-editor";
import {
  Tool,
  ToolContent,
  ToolErrorDetails,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ToolErrorLogsButton } from "./tool-error-logs-button";

type CompactToolEntry = {
  key: string;
  toolName: string;
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  errorText: string | undefined;
};

function getToolState(
  part: ToolUIPart | DynamicToolUIPart,
  toolResultPart: ToolUIPart | DynamicToolUIPart | null,
): "running" | "completed" {
  if (toolResultPart || part.state === "output-available") return "completed";
  return "running";
}

function formatToolName(toolName: string): string {
  // Remove MCP server prefix (e.g. "server__tool" -> "tool")
  const parts = toolName.split("__");
  return parts[parts.length - 1].replace(/_/g, " ");
}

function CompactCircle({
  toolName,
  state,
  isExpanded,
  onClick,
  icon,
  catalogId,
}: {
  toolName: string;
  state: "running" | "completed";
  isExpanded: boolean;
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
            className={cn(
              "relative inline-flex items-center justify-center size-8 rounded-full border transition-all",
              "hover:bg-accent hover:border-accent-foreground/20",
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
              )}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {formatToolName(toolName)}
          {state === "running" ? " (running)" : ""}
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
  onToolApprovalResponse,
}: {
  tools: CompactToolEntry[];
  toolIconMap?: ToolIconMap;
  onToolApprovalResponse?: (params: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const handleToggle = (key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key));
  };

  const expandedTool = tools.find((t) => t.key === expandedKey);

  return (
    <div className="mb-4">
      <div className="flex flex-wrap gap-1.5 items-center">
        {tools.map((tool) => {
          const iconInfo = toolIconMap?.get(tool.toolName);
          return (
            <CompactCircle
              key={tool.key}
              toolName={tool.toolName}
              state={getToolState(tool.part, tool.toolResultPart)}
              isExpanded={expandedKey === tool.key}
              onClick={() => handleToggle(tool.key)}
              icon={iconInfo?.icon}
              catalogId={iconInfo?.catalogId}
            />
          );
        })}
      </div>
      {expandedTool && (
        <div className="mt-2">
          <ExpandedToolCard
            tool={expandedTool}
            onToolApprovalResponse={onToolApprovalResponse}
          />
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
  const { part, toolResultPart, toolName, errorText } = tool;
  const hasInput = part.input && Object.keys(part.input).length > 0;
  const isApprovalRequested = part.state === "approval-requested";
  const hasContent = Boolean(
    hasInput ||
      errorText ||
      isApprovalRequested ||
      (toolResultPart && Boolean(toolResultPart.output)) ||
      (!toolResultPart && Boolean(part.output)),
  );

  const logsButton = errorText ? (
    <ToolErrorLogsButton toolName={toolName} />
  ) : null;

  const headerState = errorText
    ? "output-error"
    : toolResultPart
      ? "output-available"
      : part.state || "input-available";

  return (
    <Tool defaultOpen={true}>
      <ToolHeader
        type={`tool-${toolName}`}
        state={headerState}
        isCollapsible={hasContent}
        actionButton={logsButton}
      />
      <ToolContent>
        {hasInput ? <ToolInput input={part.input} /> : null}
        {isApprovalRequested &&
          onToolApprovalResponse &&
          "approval" in part &&
          part.approval?.id && (
            <div className="flex items-center gap-2 px-4 pb-4">
              <Button
                size="sm"
                variant="default"
                onClick={(e) => {
                  e.stopPropagation();
                  onToolApprovalResponse({
                    id: (part as { approval: { id: string } }).approval.id,
                    approved: true,
                  });
                }}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  onToolApprovalResponse({
                    id: (part as { approval: { id: string } }).approval.id,
                    approved: false,
                    reason: "User denied",
                  });
                }}
              >
                Deny
              </Button>
            </div>
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
