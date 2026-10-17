"use client";

import { ArrowUpRight, Braces } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { EncryptedChatContentUnavailable } from "@/components/encrypted-chat-content-unavailable";
import { PaneHeader } from "@/components/log-detail/pane-header";
import { ToolCallOutcomeNotice } from "@/components/log-detail/tool-call-outcome-notice";
import {
  PayloadSection,
  ToolArgumentsView,
  ToolResultView,
} from "@/components/log-detail/tool-result-view";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { McpToolCallStatusLabel } from "@/components/mcp-tool-call-status";
import { Button } from "@/components/ui/button";
import { readMcpToolCall } from "@/lib/mcp-logs/tool-call-content";
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
import { McpCallChip } from "./request-waterfall";
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
 *
 * The MCP tool call page shows its own call here inside a short excerpt:
 * `current` tags it, `timing="excerpt"` keeps only the timings that mean
 * something without the whole session, `previews` drops the payload glance
 * its right-hand column already shows in full, and `footer` replaces the link
 * to the page the reader is already on.
 */
export function ToolCallOverview({
  span,
  origin,
  previous,
  index,
  count,
  display,
  onStep,
  current = false,
  timing = "session",
  previews = true,
  footer,
}: {
  span: ToolCallSpan;
  /** Epoch ms the session's axis starts at. */
  origin: number;
  previous: TimelineSpan | null;
  index: number;
  count: number;
  display: McpServerDisplay | undefined;
  onStep: (delta: number) => void;
  current?: boolean;
  timing?: "session" | "excerpt";
  previews?: boolean;
  /** Replaces the "Open tool call" link; null drops the footer. */
  footer?: ReactNode;
}) {
  const { call } = span;
  const content = readMcpToolCall(call);
  const name = content.toolName ?? content.method;
  const gapBefore = previous ? span.start - previous.end : null;
  const footerContent =
    footer === undefined ? (
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
    ) : (
      footer
    );

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
            <McpCallChip method={content.method} />
            {current ? (
              <span className="ml-auto shrink-0 rounded-sm bg-primary/10 px-1.5 text-[10px] leading-4 font-medium text-primary">
                This call
              </span>
            ) : null}
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
              <McpToolCallStatusLabel
                status={content.status}
                dotClassName="size-1.5"
              />
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
            {timing === "session" ? (
              <OverviewFact label="Into session">
                +{formatElapsed(span.start - origin)}
              </OverviewFact>
            ) : null}
            {timing === "session" || gapBefore !== null ? (
              <OverviewFact label="After previous">
                {gapBefore == null
                  ? "First on page"
                  : gapBefore < 0
                    ? "Overlapped it"
                    : formatElapsed(gapBefore)}
              </OverviewFact>
            ) : null}
          </dl>
        </OverviewSection>

        {previews ? (
          <>
            <OverviewSection title="Arguments">
              <PayloadPreview
                locked={content.lockedArgs !== null}
                text={
                  hasArguments(content.args) ? previewJson(content.args) : null
                }
                empty="No arguments recorded"
              />
            </OverviewSection>

            <OverviewSection title="Result">
              <PayloadPreview
                locked={content.lockedResult !== null}
                text={
                  content.outcomeMessage ??
                  (content.result ? previewResult(content.result) : null)
                }
                empty="No result recorded"
                error={content.status === "error"}
              />
            </OverviewSection>
          </>
        ) : null}
      </div>

      {footerContent ? (
        <div className="border-t bg-card/70 p-3">{footerContent}</div>
      ) : null}
    </aside>
  );
}

/**
 * The right column for a selected tool call: why it did not succeed, if it
 * did not, then its full arguments and result. `outcomeNotice={false}` leaves
 * the why to a banner the page already shows.
 */
export function ToolCallPayload({
  call,
  outcomeNotice = true,
}: {
  call: SessionToolCall;
  outcomeNotice?: boolean;
}) {
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
      <div className="space-y-4 px-4 pt-2 pb-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {outcomeNotice ? (
          <ToolCallOutcomeNotice
            status={content.status}
            message={content.outcomeMessage}
          />
        ) : null}
        {content.lockedArgs ? (
          <PayloadSection title="Arguments">
            <EncryptedChatContentUnavailable value={content.lockedArgs} />
          </PayloadSection>
        ) : (
          <ToolArgumentsView args={content.args} />
        )}
        {content.lockedResult ? (
          <PayloadSection title="Result">
            <EncryptedChatContentUnavailable value={content.lockedResult} />
          </PayloadSection>
        ) : (
          <ToolResultView method={content.method} result={content.result} />
        )}
      </div>
    </section>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Arguments worth showing: an empty object says no more than none at all. */
function hasArguments(args: unknown): boolean {
  if (args === undefined || args === null) return false;
  return !(
    typeof args === "object" &&
    !Array.isArray(args) &&
    Object.keys(args).length === 0
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

/** A result's first text block before falling back to JSON. */
function previewResult(result: { content?: unknown }): string {
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
