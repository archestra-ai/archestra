"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Info, Unlink, Waypoints } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { EncryptedChatContentUnavailableLabel } from "@/components/encrypted-chat-content-unavailable";
import { ExecutedAsBadge } from "@/components/executed-as-badge";
import {
  Fact,
  FactSub,
  FactsStrip,
  FactValue,
} from "@/components/log-detail/facts-strip";
import { McpToolCallStatusLabel } from "@/components/mcp-tool-call-status";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { llmSessionHref } from "@/lib/interactions/llm-log-links";
import {
  formatAuthMethod,
  formatCallerIdentity,
} from "@/lib/mcp/mcp-tool-call.query";
import type { readMcpToolCall } from "@/lib/mcp-logs/tool-call-content";
import { formatCompactRelativeTime, formatDate } from "@/lib/utils/date-time";
import { formatLatency } from "@/lib/utils/format-duration";
import { useLinkedSession } from "./use-linked-session";

type McpToolCallRecord = archestraApiTypes.GetMcpToolCallResponses["200"];

/**
 * The call's outcome, timing and method at a glance, in the same tight card
 * as the session page's facts. Its second row is what links the call to the
 * rest of the trace: the LLM session, the run and the model's own call id,
 * or why there is none.
 */
export function ToolCallFacts({
  call,
  content,
}: {
  call: McpToolCallRecord;
  content: ReturnType<typeof readMcpToolCall>;
}) {
  const executedAs = content.executedAs;
  const authMethod = call.authMethod ? formatAuthMethod(call.authMethod) : null;
  return (
    <FactsStrip
      label="Tool call facts"
      footerLabel="Links"
      footer={<LinksRow call={call} />}
    >
      <Fact label="Status">
        <FactValue muted={content.status === "unknown"}>
          <McpToolCallStatusLabel status={content.status} />
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
        <FactValue muted={call.durationMs == null}>
          {call.durationMs != null ? formatLatency(call.durationMs) : "—"}
        </FactValue>
      </Fact>

      <Fact label="Time">
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton className="block w-full min-w-0 cursor-default text-left">
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
        {authMethod ? <FactSub>via {authMethod}</FactSub> : null}
      </Fact>

      {executedAs ? (
        <Fact label="Called as">
          <span className="flex min-h-5 items-center">
            <ExecutedAsBadge
              executedAs={executedAs}
              caller={formatCallerIdentity(call)}
            />
          </span>
        </Fact>
      ) : null}
    </FactsStrip>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function LinksRow({ call }: { call: McpToolCallRecord }) {
  const { sessionId, gone } = useLinkedSession(call);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
      {sessionId === null ? (
        <ExplainedNote
          icon={<Unlink className="size-3.5 shrink-0" aria-hidden="true" />}
          label="Not linked to an LLM session"
          question="Why isn't this call linked to a session?"
        >
          Clients link a tool call to its LLM session by sending a session
          header, such as X-Archestra-Session-Id, with the MCP request.
        </ExplainedNote>
      ) : (
        <LinkPair label="Session">
          {gone ? (
            <>
              <IdText value={sessionId} />
              <CopyButton text={sessionId} size={12} />
              <ExplainedNote
                label="no longer available"
                question="Why is the session unavailable?"
              >
                This call was recorded in an LLM session that no longer exists,
                or that you don't have permission to view.
              </ExplainedNote>
            </>
          ) : (
            <>
              <Link
                href={llmSessionHref(sessionId, { toolCall: call.id })}
                aria-label={`Session ${sessionId}`}
                title={sessionId}
                className="inline-flex items-center gap-1 font-mono underline-offset-2 hover:underline"
              >
                <Waypoints className="size-3 shrink-0" aria-hidden="true" />
                <span>{shortId(sessionId)}</span>
              </Link>
              <CopyButton text={sessionId} size={12} />
            </>
          )}
        </LinkPair>
      )}
      {call.runId ? (
        <LinkPair label="Run">
          <IdText value={call.runId} />
          <CopyButton text={call.runId} size={12} />
        </LinkPair>
      ) : null}
      {call.llmToolCallId ? (
        <LinkPair label="Model's call ID">
          <IdText value={call.llmToolCallId} />
          <CopyButton text={call.llmToolCallId} size={12} />
        </LinkPair>
      ) : null}
    </div>
  );
}

function LinkPair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="inline-flex min-w-0 items-center gap-0.5 text-foreground">
        {children}
      </span>
    </span>
  );
}

function IdText({ value }: { value: string }) {
  return (
    <span className="truncate font-mono" title={value}>
      {shortId(value)}
    </span>
  );
}

function ExplainedNote({
  icon,
  label,
  question,
  children,
}: {
  icon?: ReactNode;
  label: string;
  question: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      {icon}
      <span>{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            aria-label={question}
            className="-my-1 inline-flex size-6 cursor-default items-center justify-center rounded-sm hover:text-foreground"
          >
            <Info className="size-3.5" aria-hidden="true" />
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{children}</TooltipContent>
      </Tooltip>
    </span>
  );
}

function shortId(id: string) {
  return id.length > 15 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
