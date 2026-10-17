"use client";

import { ArrowUpRight, Braces } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { EncryptedChatContentUnavailable } from "@/components/encrypted-chat-content-unavailable";
import { JsonCodeBlock } from "@/components/json-code-block";
import { PaneHeader } from "@/components/log-detail/pane-header";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Button } from "@/components/ui/button";
import {
  MCP_TOOL_CALL_STATUS_LABELS,
  readMcpToolCall,
} from "@/lib/mcp-logs/tool-call-content";
import type { McpServerDisplay } from "@/lib/mcp-logs/use-mcp-server-display";
import { formatDate } from "@/lib/utils/date-time";
import { formatElapsed, formatLatency } from "@/lib/utils/format-duration";
import { cn } from "@/lib/utils/tailwind";
import {
  BigFigure,
  OverviewFact,
  OverviewHeader,
  OverviewSection,
} from "./overview-parts";
import { KindChip } from "./request-waterfall";
import {
  type SessionToolCall,
  SPAN_KINDS,
  type TimelineSpan,
  type ToolCallSpan,
} from "./session-timeline";

/**
 * The left column for a selected MCP tool call: which tool on which server,
 * how it went and how long it took, a glance at its arguments and result,
 * and the way to its full record.
 */
export function ToolCallOverview({
  span,
  origin,
  previous,
  index,
  count,
  display,
  onStep,
}: {
  span: ToolCallSpan;
  /** Epoch ms the session's axis starts at. */
  origin: number;
  previous: TimelineSpan | null;
  index: number;
  count: number;
  display: McpServerDisplay | undefined;
  onStep: (delta: number) => void;
}) {
  const { call } = span;
  const content = readMcpToolCall(call);
  const name = content.toolName ?? content.method;
  const gapBefore = previous ? span.start - previous.end : null;

  return (
    <aside
      aria-label="Tool call overview"
      className="flex min-w-0 flex-col border-b bg-muted/25 lg:min-h-0 lg:border-r lg:border-b-0"
    >
      <OverviewHeader index={index} count={count} onStep={onStep} />

      <div className="divide-y divide-border/60 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <OverviewSection>
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "h-4 w-[3px] shrink-0 rounded-full",
                SPAN_KINDS.tool.bar,
              )}
              aria-hidden="true"
            />
            <span className="truncate font-mono text-sm font-semibold">
              {name}
            </span>
            <KindChip kind="tool" />
          </div>
          <div className="mt-3 flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background">
              <McpCatalogIcon
                icon={display?.icon}
                catalogId={display?.catalogId}
                size={16}
              />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm leading-5 font-medium">
                {display?.name ?? call.mcpServerName}
              </span>
              <span className="block truncate font-mono text-[11px] leading-4 text-muted-foreground">
                {call.mcpServerName}
              </span>
            </span>
          </div>
          <dl className="mt-3">
            <OverviewFact label="Status">
              <ToolCallStatus status={content.status} />
            </OverviewFact>
            {content.method !== "tools/call" ? (
              <OverviewFact label="Method">
                <span className="font-mono text-[11px]">{content.method}</span>
              </OverviewFact>
            ) : null}
            <OverviewFact label="Tool call ID">
              <span className="inline-flex min-w-0 items-center gap-0.5">
                <span className="truncate font-mono text-[11px]">
                  {call.id}
                </span>
                <CopyButton text={call.id} size={11} />
              </span>
            </OverviewFact>
            {call.llmToolCallId ? (
              <OverviewFact label="Model's call ID">
                <span
                  className="truncate font-mono text-[11px]"
                  title={call.llmToolCallId}
                >
                  {call.llmToolCallId}
                </span>
              </OverviewFact>
            ) : null}
          </dl>
        </OverviewSection>

        <OverviewSection
          title="Timing"
          aside={<BigFigure value={formatLatency(call.durationMs)} />}
        >
          <dl>
            <OverviewFact label="Started">
              {formatDate({
                date: new Date(span.start).toISOString(),
                dateFormat: "HH:mm:ss.SSS",
              })}
            </OverviewFact>
            <OverviewFact label="Finished">
              {formatDate({ date: call.createdAt, dateFormat: "HH:mm:ss.SSS" })}
            </OverviewFact>
            <OverviewFact label="Into session">
              +{formatElapsed(span.start - origin)}
            </OverviewFact>
            <OverviewFact label="After previous">
              {gapBefore == null
                ? "First on page"
                : gapBefore < 0
                  ? "Overlapped it"
                  : formatElapsed(gapBefore)}
            </OverviewFact>
          </dl>
        </OverviewSection>

        <OverviewSection title="Arguments">
          <PayloadPreview
            locked={content.lockedArgs !== null}
            text={content.args === undefined ? null : previewJson(content.args)}
            empty="No arguments recorded"
          />
        </OverviewSection>

        <OverviewSection title="Result">
          <PayloadPreview
            locked={content.lockedResult !== null}
            text={content.result ? previewResult(content.result) : null}
            empty="No result recorded"
            error={content.status === "error"}
          />
        </OverviewSection>
      </div>

      <div className="border-t bg-card/70 p-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-between"
          asChild
        >
          <Link href={`/mcp/logs/${call.id}`}>
            <span>Open tool call</span>
            <ArrowUpRight />
          </Link>
        </Button>
      </div>
    </aside>
  );
}

/** The right column for a selected tool call: its full arguments and result. */
export function ToolCallPayload({ call }: { call: SessionToolCall }) {
  const content = readMcpToolCall(call);
  return (
    <section
      aria-label="Arguments and result"
      className="flex min-w-0 flex-col lg:min-h-0"
    >
      <PaneHeader>
        <Braces
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-xs font-medium">Arguments and result</span>
      </PaneHeader>
      <div className="space-y-5 p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <PayloadBlock title="Arguments">
          {content.lockedArgs ? (
            <EncryptedChatContentUnavailable value={content.lockedArgs} />
          ) : content.args === undefined ? (
            <p className="text-xs text-muted-foreground">
              No arguments recorded.
            </p>
          ) : (
            <JsonCodeBlock
              value={content.args}
              maxHeightClassName="max-h-[320px] overflow-auto"
            />
          )}
        </PayloadBlock>
        <PayloadBlock title="Result">
          {content.lockedResult ? (
            <EncryptedChatContentUnavailable value={content.lockedResult} />
          ) : (
            <JsonCodeBlock
              value={content.result}
              maxHeightClassName="max-h-[420px] overflow-auto"
            />
          )}
        </PayloadBlock>
      </div>
    </section>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function ToolCallStatus({
  status,
}: {
  status: ReturnType<typeof readMcpToolCall>["status"];
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          status === "success" && "bg-emerald-500",
          status === "error" && "bg-destructive",
          (status === "cancelled" || status === "unknown") &&
            "bg-muted-foreground/50",
        )}
      />
      <span className={cn(status === "error" && "text-destructive")}>
        {MCP_TOOL_CALL_STATUS_LABELS[status]}
      </span>
    </span>
  );
}

function PayloadBlock({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function PayloadPreview({
  locked,
  text,
  empty,
  error,
}: {
  locked: boolean;
  text: string | null;
  empty: string;
  error?: boolean;
}) {
  if (locked) {
    return <p className="text-xs text-muted-foreground">Not available</p>;
  }
  if (!text) {
    return <p className="text-xs text-muted-foreground">{empty}</p>;
  }
  return (
    <pre
      className={cn(
        "line-clamp-4 rounded-md border bg-background px-2.5 py-2 font-mono text-[11px] leading-4 break-all whitespace-pre-wrap",
        error && "border-destructive/40 text-destructive",
      )}
    >
      {text}
    </pre>
  );
}

function previewJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 1);
}

/** A result's first text block, or its error, before falling back to JSON. */
function previewResult(result: {
  isError?: boolean;
  error?: string;
  content?: unknown;
}): string {
  if (result.error) return result.error;
  if (Array.isArray(result.content)) {
    const text = result.content.find(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    );
    if (text) return text.text;
  }
  return previewJson(result.content ?? result);
}
