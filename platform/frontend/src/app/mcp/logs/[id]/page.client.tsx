"use client";

import {
  type archestraApiTypes,
  extractMcpExecutedAs,
  isLockedChatUnavailableContent,
  parseFullToolName,
} from "@archestra/shared";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ExecutedAsBadge } from "@/components/executed-as-badge";
import { JsonCodeBlock } from "@/components/json-code-block";
import { LoadingState, LoadingWrapper } from "@/components/loading";
import {
  LockedChatContentUnavailable,
  LockedChatContentUnavailableLabel,
} from "@/components/locked-chat-content-unavailable";
import { MetadataCard, MetadataItem } from "@/components/metadata-card";
import { QueryLoadError } from "@/components/query-load-error";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useProfiles } from "@/lib/agent.query";
import {
  formatAuthMethod,
  formatCallerIdentity,
  useMcpToolCall,
} from "@/lib/mcp/mcp-tool-call.query";
import { resolveMcpToolCallStatus } from "@/lib/mcp-logs/tool-call-status";
import { formatDate } from "@/lib/utils";

export function McpToolCallDetailPage({
  initialData,
  id,
}: {
  initialData?: {
    mcpToolCall: archestraApiTypes.GetMcpToolCallResponses["200"] | undefined;
  };
  id: string;
}) {
  return (
    <div className="w-full h-full overflow-y-auto">
      <ErrorBoundary>
        <McpToolCallDetail initialData={initialData} id={id} />
      </ErrorBoundary>
    </div>
  );
}

function McpToolCallDetail({
  initialData,
  id,
}: {
  initialData?: {
    mcpToolCall: archestraApiTypes.GetMcpToolCallResponses["200"] | undefined;
  };
  id: string;
}) {
  const {
    data: mcpToolCall,
    isPending,
    isLoadingError,
    refetch,
  } = useMcpToolCall({
    mcpToolCallId: id,
    initialData: initialData?.mcpToolCall,
  });

  const { data: agents } = useProfiles();

  if (isPending) {
    return <LoadingState label="Loading tool call…" variant="page" />;
  }

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load this tool call"
        onRetry={() => refetch()}
      />
    );
  }

  if (!mcpToolCall) {
    return (
      <div className="text-muted-foreground p-8">MCP tool call not found</div>
    );
  }

  const agent = agents?.find((a) => a.id === mcpToolCall.agentId);
  const method = mcpToolCall.method || "tools/call";
  // A locked chat's tool call and result are stored encrypted (or,
  // in the fail-closed case, not at all), so the columns hold a sentinel rather
  // than the recorded content. Split them out before anything reads a field off
  // them — the tool name, the arguments and the success/error status are all
  // equally unavailable, and painting the call "Success" would be a claim the
  // row does not support.
  // The redaction fallback nests the marker in `arguments` instead of
  // replacing the whole call, so both shapes have to resolve to "unavailable".
  const nestedRedactedArgs = (
    mcpToolCall.toolCall as { arguments?: unknown } | null
  )?.arguments;
  const lockedToolCall = isLockedChatUnavailableContent(mcpToolCall.toolCall)
    ? mcpToolCall.toolCall
    : isLockedChatUnavailableContent(nestedRedactedArgs)
      ? nestedRedactedArgs
      : null;
  const lockedToolResult = isLockedChatUnavailableContent(
    mcpToolCall.toolResult,
  )
    ? mcpToolCall.toolResult
    : null;

  const toolCall = lockedToolCall
    ? null
    : (mcpToolCall.toolCall as {
        name?: string;
        arguments?: unknown;
      } | null);
  const toolResult = lockedToolResult
    ? null
    : (mcpToolCall.toolResult as {
        isError?: boolean;
        error?: string;
        content?: unknown;
      } | null);

  // Whose credential served the call upstream, recorded with the result.
  const executedAs = extractMcpExecutedAs(toolResult);

  // Success / error / cancelled — a cancelled call (the user stopped the run
  // or the background task) is neither a success nor a failure.
  const status =
    method === "tools/call" && toolResult
      ? resolveMcpToolCallStatus(toolResult)
      : "success";

  return (
    <LoadingWrapper isPending={isPending}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/mcp/logs">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to MCP Logs
            </Link>
          </Button>
        </div>

        <MetadataCard
          title="Metadata"
          badges={
            <>
              <Badge
                variant={
                  method === "initialize"
                    ? "outline"
                    : method === "tools/list"
                      ? "secondary"
                      : "default"
                }
                className="text-xs"
              >
                {method}
              </Badge>
              {lockedToolResult ? (
                <LockedChatContentUnavailableLabel value={lockedToolResult} />
              ) : (
                <Badge
                  variant={
                    status === "error"
                      ? "destructive"
                      : status === "cancelled"
                        ? "secondary"
                        : "default"
                  }
                  className="text-xs"
                >
                  {status === "error"
                    ? "Error"
                    : status === "cancelled"
                      ? "Cancelled"
                      : "Success"}
                </Badge>
              )}
            </>
          }
        >
          {mcpToolCall.ownerType === "app" ? (
            <MetadataItem label="App">
              <div className="font-semibold">
                {mcpToolCall.appName ?? "Deleted App"}
              </div>
            </MetadataItem>
          ) : (
            <MetadataItem label="MCP Gateway">
              <div className="font-semibold">
                {agent?.name ??
                  (mcpToolCall.agentId === null
                    ? "Deleted MCP Gateway"
                    : "Unknown")}
              </div>
            </MetadataItem>
          )}
          <MetadataItem label="MCP Server">
            <div className="font-mono">{mcpToolCall.mcpServerName}</div>
          </MetadataItem>
          {toolCall?.name && (
            <MetadataItem label="Tool Name">
              <div className="font-mono">
                {parseFullToolName(toolCall.name).toolName || toolCall.name}
              </div>
            </MetadataItem>
          )}
          <MetadataItem label="Timestamp">
            <div className="font-mono text-xs">
              {formatDate({ date: mcpToolCall.createdAt })}
            </div>
          </MetadataItem>
          {mcpToolCall.userName && (
            <MetadataItem label="User">
              <div>{mcpToolCall.userName}</div>
            </MetadataItem>
          )}
          {mcpToolCall.authMethod && (
            <MetadataItem label="Auth Method">
              <Badge variant="secondary" className="text-xs">
                {formatAuthMethod(mcpToolCall.authMethod)}
              </Badge>
            </MetadataItem>
          )}
          {executedAs && (
            <MetadataItem label="Called as">
              <ExecutedAsBadge
                executedAs={executedAs}
                caller={formatCallerIdentity(mcpToolCall)}
              />
            </MetadataItem>
          )}
        </MetadataCard>

        {(lockedToolCall || toolCall?.arguments !== undefined) && (
          <Accordion type="single" collapsible className="mb-4">
            <AccordionItem
              value="arguments"
              className="border rounded-lg !border-b"
            >
              <AccordionTrigger className="px-6 py-4 hover:no-underline">
                <span className="text-base font-semibold">Arguments</span>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-4">
                {lockedToolCall ? (
                  <LockedChatContentUnavailable value={lockedToolCall} />
                ) : (
                  <JsonCodeBlock value={toolCall?.arguments} />
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}

        <Accordion type="single" collapsible defaultValue="result">
          <AccordionItem value="result" className="border rounded-lg !border-b">
            <AccordionTrigger className="px-6 py-4 hover:no-underline">
              <span className="text-base font-semibold">Result</span>
            </AccordionTrigger>
            <AccordionContent className="px-6 pb-4">
              {lockedToolResult ? (
                <LockedChatContentUnavailable value={lockedToolResult} />
              ) : (
                <JsonCodeBlock value={toolResult} />
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </LoadingWrapper>
  );
}
