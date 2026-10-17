"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
} from "@archestra/shared";
import {
  AppWindow,
  ArrowRight,
  Braces,
  Info,
  TriangleAlert,
  Unlink,
  Waypoints,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AgentIdenticon } from "@/app/llm/logs/_parts/hue-avatar";
import { sourceLabel } from "@/app/llm/logs/_parts/logs-table-format";
import { CopyButton } from "@/components/copy-button";
import {
  EncryptedChatContentUnavailable,
  EncryptedChatContentUnavailableLabel,
} from "@/components/encrypted-chat-content-unavailable";
import { ExecutedAsBadge } from "@/components/executed-as-badge";
import { JsonCodeBlock } from "@/components/json-code-block";
import {
  Fact,
  FactSub,
  FactsStrip,
  FactValue,
} from "@/components/log-detail/facts-strip";
import { PaneHeader } from "@/components/log-detail/pane-header";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { SourceIcon } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useAgentOptions } from "@/lib/agent.query";
import { useInteractionSessions } from "@/lib/interactions/interaction.query";
import {
  formatAuthMethod,
  formatCallerIdentity,
  useMcpToolCall,
} from "@/lib/mcp/mcp-tool-call.query";
import {
  MCP_TOOL_CALL_STATUS_LABELS,
  type McpToolCallOutcomeStatus,
  readMcpToolCall,
} from "@/lib/mcp-logs/tool-call-content";
import {
  type McpServerDisplay,
  useMcpServerDisplayByName,
} from "@/lib/mcp-logs/use-mcp-server-display";
import { formatCompactRelativeTime, formatDate } from "@/lib/utils/date-time";
import { formatLatency } from "@/lib/utils/format-duration";
import { cn } from "@/lib/utils/tailwind";

type McpToolCallRecord = archestraApiTypes.GetMcpToolCallResponses["200"];

export function McpToolCallDetailPage({
  initialData,
  id,
}: {
  initialData?: {
    mcpToolCall: McpToolCallRecord | undefined;
  };
  id: string;
}) {
  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={150}>
        <McpToolCallDetail initialData={initialData} id={id} />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function McpToolCallDetail({
  initialData,
  id,
}: {
  initialData?: {
    mcpToolCall: McpToolCallRecord | undefined;
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
  const { displayByName } = useMcpServerDisplayByName();

  const { data: agents } = useAgentOptions({
    filters: { ids: mcpToolCall?.agentId ? [mcpToolCall.agentId] : [] },
    enabled: !!mcpToolCall?.agentId,
  });

  // The header stays put through loading, failure and not-found: this page
  // owns its own chrome, so returning bare content would leave a reader
  // staring at a spinner with no title and no way back to the list.
  if (isPending) {
    return (
      <ToolCallShell>
        <div className="space-y-6" aria-busy="true">
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
  const agent = agents?.find((a) => a.id === mcpToolCall.agentId);
  // What was actually called, which is the record's identity. A `tools/call`
  // is named by its tool; `initialize` and `tools/list` are named by the
  // method itself.
  const title = content.toolName ?? content.method;

  return (
    <PageLayout
      title={<ToolCallHeaderTitle display={display} title={title} />}
      documentTitle={title}
      stackHeaderOnMobile
      backLink={<PageBackLink href="/mcp/logs">Back to MCP Logs</PageBackLink>}
      description={
        <ToolCallIdentityLine
          call={mcpToolCall}
          display={display}
          agentName={agent?.name}
        />
      }
    >
      <div className="space-y-6 pb-10">
        <SessionLink call={mcpToolCall} />
        <ToolCallFacts call={mcpToolCall} content={content} />

        {/* overflow-clip, not hidden, below lg: hidden would make the card a
            scroll container and break the sticky pane headers. */}
        <section
          aria-label="Arguments and result"
          className="grid overflow-clip rounded-lg border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.03)] lg:grid-cols-2"
        >
          <ArgumentsPane content={content} />
          <ResultPane content={content} />
        </section>
      </div>
    </PageLayout>
  );
}

/** The page's header while there is no record to name it with. */
function ToolCallShell({ children }: { children: ReactNode }) {
  return (
    <PageLayout
      title="Tool call"
      backLink={<PageBackLink href="/mcp/logs">Back to MCP Logs</PageBackLink>}
    >
      {children}
    </PageLayout>
  );
}

/**
 * The tool's name behind its server's 44px tile, laid out like the session
 * page's title: from `lg` the tile fronts both header lines.
 */
function ToolCallHeaderTitle({
  display,
  title,
}: {
  display: McpServerDisplay | undefined;
  title: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-3.5">
      <span className="shrink-0 lg:relative lg:h-8 lg:w-11">
        <span className="block lg:absolute lg:top-1.5 lg:left-0">
          <ServerTile display={display} />
        </span>
      </span>
      <span className="min-w-0 font-mono text-xl leading-7 break-all lg:text-2xl lg:leading-8">
        {title}
      </span>
    </span>
  );
}

function ServerTile({ display }: { display: McpServerDisplay | undefined }) {
  const hasMark =
    Boolean(display?.icon) || display?.catalogId === ARCHESTRA_MCP_CATALOG_ID;
  return (
    <span
      aria-hidden="true"
      className="flex size-11 items-center justify-center overflow-hidden rounded-[11px] border border-border/70 bg-background text-muted-foreground"
    >
      {hasMark || !display ? (
        <McpCatalogIcon
          icon={display?.icon}
          catalogId={display?.catalogId}
          size={22}
        />
      ) : (
        <span className="font-sans text-lg font-semibold text-foreground/80">
          {display.name.trim().charAt(0).toUpperCase()}
        </span>
      )}
    </span>
  );
}

/**
 * "Priya Raman via OAuth · GitHub · [gateway]", lined up under the title text
 * the same way the session page lines up its identity.
 */
function ToolCallIdentityLine({
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

  const items: { key: string; node: ReactNode }[] = [
    {
      key: "who",
      node: (
        <span className="inline-flex min-w-0 items-center gap-1">
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
            <span className="font-medium text-foreground">{actor.label}</span>
          )}
          <span className="text-muted-foreground/70">via</span>
          <span className="inline-flex items-center gap-1 text-foreground/80 [&_svg]:size-3.5">
            {call.source === "chat" ? <SourceIcon source="chat" /> : null}
            {via}
          </span>
        </span>
      ),
    },
    {
      key: "server",
      node: (
        <span
          className="inline-flex min-w-0 items-center gap-1.5"
          title={call.mcpServerName}
        >
          <McpCatalogIcon
            icon={display?.icon}
            catalogId={display?.catalogId}
            size={14}
          />
          <span className="truncate">
            {display?.name ?? (
              <span className="font-mono text-xs">{call.mcpServerName}</span>
            )}
          </span>
        </span>
      ),
    },
    {
      key: "owner",
      node:
        call.ownerType === "app" ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <AppWindow className="size-3.5 opacity-70" aria-hidden="true" />
            <span className="sr-only">App:</span>
            <span className="truncate">{call.appName ?? "Deleted App"}</span>
          </span>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5">
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
        ),
    },
  ];

  // Every item leads with its own separator; the row is pulled left by one
  // separator's width and clipped, so the dot that would start a wrapped line
  // is hidden instead of dangling there.
  return (
    <div className={IDENTITY_INSET}>
      <div className="-my-0.5 overflow-hidden py-0.5">
        <div className="-ml-6 flex flex-wrap items-center gap-y-1 text-sm text-muted-foreground">
          {items.map((item) => (
            <span key={item.key} className="inline-flex min-w-0 items-center">
              <span
                aria-hidden="true"
                className="w-6 shrink-0 text-center text-muted-foreground/50"
              >
                ·
              </span>
              {item.node}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Lines the identity up under the title text: tile (44) + gap (14), plus the
 * back arrow that leads the title row from `lg`. Matches the session page.
 */
const IDENTITY_INSET = "pl-[58px] lg:pl-[90px]";

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

/** Where this call sits in an LLM session, or a quiet note that it doesn't. */
function SessionLink({ call }: { call: McpToolCallRecord }) {
  const sessionId = call.sessionId;
  const { data: sessionResponse } = useInteractionSessions({
    sessionId: sessionId ?? undefined,
    limit: 1,
    toastOnError: false,
    enabled: sessionId !== null,
  });

  if (!sessionId) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Unlink className="size-3.5 shrink-0" aria-hidden="true" />
        <span>Not linked to an LLM session</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton
              aria-label="Why isn't this call linked to a session?"
              className="inline-flex cursor-default rounded-sm hover:text-foreground"
            >
              <Info className="size-3.5" aria-hidden="true" />
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            Clients link a tool call to its LLM session by sending a session
            header, such as X-Archestra-Session-Id, with the MCP request.
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  const session = sessionResponse?.data?.[0];
  const sessionTitle =
    session?.claudeCodeTitle ??
    session?.conversationTitle ??
    session?.lastUserMessagePreview ??
    null;
  const href = `/llm/logs/session/${encodeURIComponent(sessionId)}?toolCall=${encodeURIComponent(call.id)}`;

  return (
    <section
      aria-label="LLM session"
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-primary/25 bg-primary/[0.04] px-4 py-3"
    >
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
      >
        <Waypoints className="size-4" />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <div className="text-xs text-muted-foreground">
          Part of an LLM session
        </div>
        {sessionTitle ? (
          <>
            <div className="truncate text-sm font-medium">{sessionTitle}</div>
            <div className="truncate font-mono text-[11px] leading-4 text-muted-foreground">
              {sessionId}
            </div>
          </>
        ) : (
          <div className="truncate font-mono text-sm">{sessionId}</div>
        )}
      </div>
      <Button size="sm" className="max-sm:w-full" asChild>
        <Link href={href}>
          <span>View in session</span>
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </section>
  );
}

function ToolCallFacts({
  call,
  content,
}: {
  call: McpToolCallRecord;
  content: ReturnType<typeof readMcpToolCall>;
}) {
  const executedAs = content.executedAs;
  return (
    <FactsStrip label="Tool call facts">
      <Fact label="Status">
        <FactValue muted={content.status === "unknown"}>
          <StatusDot status={content.status} />
          <span
            className={cn(content.status === "error" && "text-destructive")}
          >
            {MCP_TOOL_CALL_STATUS_LABELS[content.status]}
          </span>
        </FactValue>
        {content.status === "unknown" && content.lockedResult ? (
          <FactSub>
            <EncryptedChatContentUnavailableLabel
              value={content.lockedResult}
            />
          </FactSub>
        ) : null}
      </Fact>

      <Fact label="Duration">
        {call.durationMs != null ? (
          <FactValue>{formatLatency(call.durationMs)}</FactValue>
        ) : (
          <FactValue muted>—</FactValue>
        )}
      </Fact>

      <Fact label="Time">
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton className="block cursor-default text-left">
              <FactValue>
                {formatDate({
                  date: call.createdAt,
                  dateFormat: "MMM d, HH:mm:ss",
                })}
              </FactValue>
              <FactSub>{formatCompactRelativeTime(call.createdAt)}</FactSub>
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent className="px-2 py-1.5 font-mono tabular-nums">
            {formatDate({ date: call.createdAt })}
          </TooltipContent>
        </Tooltip>
      </Fact>

      <Fact label="Method">
        <FactValue>
          <span className="font-mono text-sm font-medium">
            {content.method}
          </span>
        </FactValue>
      </Fact>

      <Fact label="Auth method">
        <FactValue>
          <span className="text-sm font-medium">
            {formatAuthMethod(call.authMethod)}
          </span>
        </FactValue>
      </Fact>

      {executedAs ? (
        <Fact label="Called as">
          <span className="flex min-h-6 items-center">
            <ExecutedAsBadge
              executedAs={executedAs}
              caller={formatCallerIdentity(call)}
            />
          </span>
        </Fact>
      ) : null}

      {call.runId ? (
        <Fact label="Run ID">
          <IdValue value={call.runId} />
        </Fact>
      ) : null}

      {call.llmToolCallId ? (
        <Fact label="LLM tool call ID">
          <IdValue value={call.llmToolCallId} />
        </Fact>
      ) : null}
    </FactsStrip>
  );
}

function StatusDot({ status }: { status: McpToolCallOutcomeStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "success" && "bg-emerald-500",
        status === "error" && "bg-destructive",
        (status === "cancelled" || status === "unknown") &&
          "bg-muted-foreground/50",
      )}
    />
  );
}

/** A long id, its middle elided, with the full value one copy away. */
function IdValue({ value }: { value: string }) {
  return (
    <span className="flex min-h-6 min-w-0 items-center gap-0.5">
      <span className="truncate font-mono text-sm" title={value}>
        {truncateMiddle(value)}
      </span>
      <CopyButton text={value} size={12} />
    </span>
  );
}

function truncateMiddle(value: string, head = 8, tail = 6): string {
  return value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function ArgumentsPane({
  content,
}: {
  content: ReturnType<typeof readMcpToolCall>;
}) {
  const args = content.args;
  const fieldCount =
    args && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args).length
      : null;
  return (
    <div className="flex min-w-0 flex-col max-lg:border-b lg:border-r">
      <PaneHeader>
        <Braces
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="text-xs font-medium">Arguments</h2>
        {fieldCount !== null ? (
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {fieldCount === 1 ? "1 field" : `${fieldCount} fields`}
          </span>
        ) : null}
      </PaneHeader>
      <div className="min-w-0 p-4">
        {content.lockedArgs ? (
          <EncryptedChatContentUnavailable value={content.lockedArgs} />
        ) : args === undefined ? (
          <p className="text-xs text-muted-foreground">
            No arguments recorded.
          </p>
        ) : (
          <JsonCodeBlock
            value={args}
            maxHeightClassName="max-h-[640px] overflow-auto"
          />
        )}
      </div>
    </div>
  );
}

function ResultPane({
  content,
}: {
  content: ReturnType<typeof readMcpToolCall>;
}) {
  const isError = content.status === "error";
  const result = content.result;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        isError && "bg-destructive/[0.03]",
      )}
    >
      <PaneHeader className={cn(isError && "border-b-destructive/25")}>
        <Braces
          className={cn(
            "size-3.5 shrink-0",
            isError ? "text-destructive" : "text-muted-foreground",
          )}
          aria-hidden="true"
        />
        <h2
          className={cn("text-xs font-medium", isError && "text-destructive")}
        >
          Result
        </h2>
        {content.status !== "unknown" ? (
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-1.5 text-[11px]",
              isError ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <StatusDot status={content.status} />
            {MCP_TOOL_CALL_STATUS_LABELS[content.status]}
          </span>
        ) : null}
      </PaneHeader>
      <div className="min-w-0 space-y-3 p-4">
        {content.lockedResult ? (
          <EncryptedChatContentUnavailable value={content.lockedResult} />
        ) : result === null ? (
          <p className="text-xs text-muted-foreground">No result recorded.</p>
        ) : (
          <>
            {isError && result.error ? (
              <InlineNotice variant="error">
                <TriangleAlert />
                <InlineNoticeText className="break-words">
                  {result.error}
                </InlineNoticeText>
              </InlineNotice>
            ) : null}
            <div
              className={cn(
                // JsonCodeBlock wraps the code block's bordered root.
                isError && "[&>div>div]:border-destructive/40",
              )}
            >
              <JsonCodeBlock
                value={result}
                maxHeightClassName="max-h-[640px] overflow-auto"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
