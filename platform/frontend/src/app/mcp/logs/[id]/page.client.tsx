"use client";

import type { ReactNode } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ToolCallPayload } from "@/app/llm/logs/[id]/_parts/tool-call-details";
import { ToolCallOutcomeNotice } from "@/components/log-detail/tool-call-outcome-notice";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";
import { useMcpToolCall } from "@/lib/mcp/mcp-tool-call.query";
import { readMcpToolCall } from "@/lib/mcp-logs/tool-call-content";
import { useMcpServerDisplayByName } from "@/lib/mcp-logs/use-mcp-server-display";
import { CallExcerpt } from "./_parts/call-excerpt";
import { ToolCallFacts } from "./_parts/tool-call-facts";
import {
  ToolCallHeaderIcon,
  ToolCallHeaderTitle,
  ToolCallIdentityLine,
} from "./_parts/tool-call-header";

export function McpToolCallDetailPage({ id }: { id: string }) {
  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={150}>
        <McpToolCallDetail id={id} />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * One logged MCP call: what it was, how it went, its arguments and result,
 * and then what happened around it. The excerpt at the bottom is the session
 * page's own request list, trimmed to the records on either side of this
 * call; picking one of them previews it there.
 */
function McpToolCallDetail({ id }: { id: string }) {
  const {
    data: mcpToolCall,
    isPending,
    isLoadingError,
    refetch,
  } = useMcpToolCall({ mcpToolCallId: id });
  const { displayByName } = useMcpServerDisplayByName();

  const { data: agents } = useAgentOptionsByIds({
    ids: mcpToolCall?.agentId ? [mcpToolCall.agentId] : [],
  });

  // The header stays put through loading, failure and not-found: this page
  // owns its own chrome, so returning bare content would leave a reader
  // staring at a spinner with no title and no way back to the list.
  if (isPending) {
    return (
      <ToolCallShell>
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-72 w-full rounded-lg" />
        </div>
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

  const content = readMcpToolCall(mcpToolCall);
  const display = displayByName.get(mcpToolCall.mcpServerName);
  const agentName = agents?.find((a) => a.id === mcpToolCall.agentId)?.name;
  // What was actually called, which is the record's identity. A `tools/call`
  // is named by its tool; `initialize` and `tools/list` are named by the
  // method itself.
  const title = content.toolName ?? content.method;

  return (
    <PageLayout
      denseContent
      // Laid out like every other detail page: back arrow, the server's mark
      // in its tile, then the title over its one-line description.
      icon={<ToolCallHeaderIcon display={display} />}
      title={<ToolCallHeaderTitle title={title} method={content.method} />}
      documentTitle={title}
      stackHeaderOnMobile
      backLink={<PageBackLink href="/mcp/logs">Back to MCP Logs</PageBackLink>}
      description={
        <ToolCallIdentityLine
          call={mcpToolCall}
          display={display}
          agentName={agentName}
        />
      }
    >
      <div className="space-y-4">
        <ToolCallFacts call={mcpToolCall} content={content} />
        <ToolCallOutcomeNotice
          status={content.status}
          message={content.outcomeMessage}
        />
        {/* The call's own payload comes first: it is what this page was
            opened for. The records around it follow, as context. */}
        <div className="overflow-hidden rounded-lg border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.03)]">
          <ToolCallPayload call={mcpToolCall} outcomeNotice={false} />
        </div>
        <CallExcerpt call={mcpToolCall} agentName={agentName} />
      </div>
    </PageLayout>
  );
}

/** The page's header while there is no record to name it with. */
function ToolCallShell({ children }: { children: ReactNode }) {
  return (
    <PageLayout
      denseContent
      title="Tool call"
      backLink={<PageBackLink href="/mcp/logs">Back to MCP Logs</PageBackLink>}
    >
      {children}
    </PageLayout>
  );
}
