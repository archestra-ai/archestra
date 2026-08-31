"use client";

import {
  type archestraApiTypes,
  extractMcpExecutedAs,
  isLockedChatUnavailableContent,
  parseFullToolName,
} from "@archestra/shared";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { type DetailFact, DetailFacts } from "@/components/detail-facts";
import { ExecutedAsBadge } from "@/components/executed-as-badge";
import { JsonCodeBlock } from "@/components/json-code-block";
import { LoadingState, LoadingWrapper } from "@/components/loading";
import {
  LockedChatContentUnavailable,
  LockedChatContentUnavailableLabel,
} from "@/components/locked-chat-content-unavailable";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
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
    <ErrorBoundary>
      <McpToolCallDetail initialData={initialData} id={id} />
    </ErrorBoundary>
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

  // The header stays put through loading, failure and not-found: this page
  // owns its own chrome now, so returning bare content would leave a reader
  // staring at a spinner with no title and no way back to the list.
  if (isPending) {
    return (
      <ToolCallShell>
        <LoadingState label="Loading tool call…" />
      </ToolCallShell>
    );
  }

  if (isLoadingError) {
    return (
      <ToolCallShell>
        <QueryLoadError
          title="Couldn't load this tool call"
          onRetry={() => refetch()}
        />
      </ToolCallShell>
    );
  }

  if (!mcpToolCall) {
    return (
      <ToolCallShell>
        <div className="text-muted-foreground">MCP tool call not found</div>
      </ToolCallShell>
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

  // What was actually called, which is the record's identity. A `tools/call`
  // is named by its tool; `initialize` and `tools/list` are named by the
  // method itself, so the method is the title there and a fact here.
  const toolName = toolCall?.name
    ? parseFullToolName(toolCall.name).toolName || toolCall.name
    : null;

  const facts: DetailFact[] = [
    mcpToolCall.ownerType === "app"
      ? { label: "App", value: mcpToolCall.appName ?? "Deleted App" }
      : {
          label: "MCP Gateway",
          value:
            agent?.name ??
            (mcpToolCall.agentId === null ? "Deleted MCP Gateway" : "Unknown"),
        },
    {
      label: "MCP Server",
      value: <span className="font-mono">{mcpToolCall.mcpServerName}</span>,
    },
    // Only when the title is not already the method: an `initialize` record is
    // titled by its method, and a fact restating it says nothing twice.
    ...(toolName
      ? [
          {
            label: "Method",
            value: <span className="font-mono">{method}</span>,
          },
        ]
      : []),
    ...(mcpToolCall.userName
      ? [{ label: "User", value: mcpToolCall.userName }]
      : []),
    ...(mcpToolCall.authMethod
      ? [
          {
            label: "Auth method",
            value: (
              <Badge variant="secondary" className="text-xs">
                {formatAuthMethod(mcpToolCall.authMethod)}
              </Badge>
            ),
          },
        ]
      : []),
    ...(mcpToolCall.executionId
      ? [
          {
            label: "Execution ID",
            value: <span className="font-mono">{mcpToolCall.executionId}</span>,
          },
        ]
      : []),
    ...(executedAs
      ? [
          {
            label: "Called as",
            value: (
              <ExecutedAsBadge
                executedAs={executedAs}
                caller={formatCallerIdentity(mcpToolCall)}
              />
            ),
          },
        ]
      : []),
    {
      label: "Timestamp",
      value: (
        <span className="font-mono tabular-nums">
          {formatDate({ date: mcpToolCall.createdAt })}
        </span>
      ),
    },
  ];

  return (
    <LoadingWrapper isPending={isPending}>
      <PageLayout
        title={
          <span className={toolName ? "font-mono" : undefined}>
            {toolName ?? method}
          </span>
        }
        documentTitle={toolName ?? method}
        backLink={
          <PageBackLink href="/mcp/logs">Back to MCP Logs</PageBackLink>
        }
        // Whether the call succeeded is the one live fact about this record,
        // which is exactly what the header's status slot is for.
        status={
          lockedToolResult ? (
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
          )
        }
      >
        <div className="space-y-6">
          <DetailFacts facts={facts} className="border-b pb-6" />

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
            <AccordionItem
              value="result"
              className="border rounded-lg !border-b"
            >
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
      </PageLayout>
    </LoadingWrapper>
  );
}

/** The page's header while there is no record to name it with. */
function ToolCallShell({ children }: { children: React.ReactNode }) {
  return (
    <PageLayout
      title="Tool call"
      backLink={<PageBackLink href="/mcp/logs">Back to MCP Logs</PageBackLink>}
    >
      {children}
    </PageLayout>
  );
}
