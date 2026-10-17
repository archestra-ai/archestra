"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { ArrowUpRight, TriangleAlert, Waypoints } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { sessionTitleOf } from "@/app/llm/logs/_parts/logs-table-format";
import { RequestDetails } from "@/app/llm/logs/[id]/_parts/request-details";
import { RequestWaterfall } from "@/app/llm/logs/[id]/_parts/request-waterfall";
import {
  type InteractionSummary,
  type Timeline,
  type TimelineSpan,
  toolCallSpanKey,
} from "@/app/llm/logs/[id]/_parts/session-timeline";
import {
  DETAILS_PANE_DEFAULT_HEIGHT,
  SplitHandle,
} from "@/app/llm/logs/[id]/_parts/split-handle";
import { Button } from "@/components/ui/button";
import { InlineNotice } from "@/components/ui/inline-notice";
import { useInteractionSummaries } from "@/lib/interactions/interaction.query";
import {
  llmRequestHref,
  llmSessionHref,
} from "@/lib/interactions/llm-log-links";
import {
  useMcpToolCalls,
  useSessionMcpToolCalls,
} from "@/lib/mcp/mcp-tool-call.query";
import { useMcpServerDisplayByName } from "@/lib/mcp-logs/use-mcp-server-display";
import { cn } from "@/lib/utils/tailwind";
import { buildExcerptTimeline } from "./excerpt-timeline";
import { OwnerLabel } from "./tool-call-header";
import { useLinkedSession } from "./use-linked-session";

type McpToolCallRecord = archestraApiTypes.GetMcpToolCallResponses["200"];

/**
 * The call among the records around it, drawn with the session page's own
 * request list and details pane. A call linked to an LLM session shows the
 * session's requests and tool calls on either side of it, with the way into
 * the full trace. A call with no session, or whose session is gone, shows the
 * same gateway's or app's calls from the minutes around it instead.
 */
export function CallExcerpt({
  call,
  agentName,
}: {
  call: McpToolCallRecord;
  agentName: string | undefined;
}) {
  const { sessionId, session, gone } = useLinkedSession(call);
  if (sessionId !== null && !gone) {
    return (
      <SessionExcerpt call={call} sessionId={sessionId} session={session} />
    );
  }
  return <NeighbourExcerpt call={call} agentName={agentName} />;
}

// ============================================================================
// Internal helpers
// ============================================================================

type LogSession =
  archestraApiTypes.GetInteractionSessionsResponses["200"]["data"][number];

/** Requests fetched on each side of the call; the excerpt trims to six. */
const REQUESTS_EACH_SIDE = 6;
/** How far either side of an unlinked call to look for its neighbours. */
const NEIGHBOUR_WINDOW_MS = 15 * 60_000;
/** The list endpoint's largest page. */
const NEIGHBOUR_LIMIT = 100;

function SessionExcerpt({
  call,
  sessionId,
  session,
}: {
  call: McpToolCallRecord;
  sessionId: string;
  session: LogSession | undefined;
}) {
  const older = useInteractionSummaries({
    sessionId,
    endDate: call.createdAt,
    limit: REQUESTS_EACH_SIDE,
    sortBy: "createdAt",
    sortDirection: "desc",
  });
  const newer = useInteractionSummaries({
    sessionId,
    startDate: call.createdAt,
    limit: REQUESTS_EACH_SIDE,
    sortBy: "createdAt",
    sortDirection: "asc",
  });
  const requestsReady = older.isSuccess && newer.isSuccess;
  const requests = useMemo(() => {
    const byId = new Map<string, InteractionSummary>();
    for (const row of [
      ...(older.data?.data ?? []),
      ...(newer.data?.data ?? []),
    ]) {
      byId.set(row.id, row);
    }
    return [...byId.values()];
  }, [older.data, newer.data]);

  // The tool calls between the first request's start and the last one's end.
  const windowStart = Math.min(
    startOf(call),
    ...requests.map((row) => startOf(row)),
  );
  const newest = newer.data?.data.at(-1);
  const toolCalls = useSessionMcpToolCalls({
    sessionId,
    startDate: new Date(windowStart).toISOString(),
    endDate: newest?.createdAt,
    enabled: requestsReady,
  });

  const excerpt = useMemo(
    () =>
      requestsReady && toolCalls.isSuccess
        ? buildExcerptTimeline({
            requests,
            toolCalls: toolCalls.data.data,
            call,
          })
        : null,
    [requestsReady, requests, toolCalls.isSuccess, toolCalls.data, call],
  );

  const failed = older.isError || newer.isError || toolCalls.isError;
  const href = llmSessionHref(sessionId, { toolCall: call.id });
  const requestsShown =
    excerpt?.timeline?.spans.filter((span) => span.type === "request").length ??
    0;
  const sessionTitle = session ? sessionTitleOf(session) : null;

  return (
    <ExcerptCard
      call={call}
      timeline={excerpt?.timeline ?? null}
      loading={!failed && excerpt === null}
      profileName={session?.profileName ?? null}
      title="Session excerpt"
      countLabel={
        excerpt && session
          ? `Showing ${requestsShown} of ${session.requestCount.toLocaleString()} ${session.requestCount === 1 ? "request" : "requests"}`
          : undefined
      }
      action={
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-foreground"
          asChild
        >
          <Link href={href}>
            {/* Phones show the glyph alone beside the card's title. */}
            <span className="max-lg:sr-only">Open full trace</span>
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </Button>
      }
      notice={
        failed ? (
          <LoadFailedNotice
            onRetry={() => {
              if (older.isError) older.refetch();
              if (newer.isError) newer.refetch();
              if (toolCalls.isError) toolCalls.refetch();
            }}
          />
        ) : null
      }
      status={
        <>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Waypoints className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate text-foreground/80">
              {sessionTitle ?? sessionId}
            </span>
          </span>
          {session ? (
            <StatusPart>
              {session.requestCount.toLocaleString()}{" "}
              {session.requestCount === 1 ? "request" : "requests"} in session
            </StatusPart>
          ) : null}
          {excerpt ? (
            <StatusPart wideOnly>
              {excerpt.before} before · {excerpt.after} after this call
            </StatusPart>
          ) : null}
        </>
      }
    />
  );
}

function NeighbourExcerpt({
  call,
  agentName,
}: {
  call: McpToolCallRecord;
  agentName: string | undefined;
}) {
  const center = new Date(call.createdAt).getTime();
  const isApp = call.ownerType === "app";
  const ownerId = isApp ? call.appId : call.agentId;
  // The list filters by gateway; an app's calls are picked out of the window.
  const neighbours = useMcpToolCalls({
    agentId: isApp ? undefined : (call.agentId ?? undefined),
    startDate: new Date(center - NEIGHBOUR_WINDOW_MS).toISOString(),
    endDate: new Date(center + NEIGHBOUR_WINDOW_MS).toISOString(),
    limit: NEIGHBOUR_LIMIT,
    enabled: ownerId !== null,
  });

  const excerpt = useMemo(() => {
    // A deleted gateway or app has nothing left to match its calls by.
    if (ownerId === null) {
      return {
        ...buildExcerptTimeline({ requests: [], toolCalls: [], call }),
        total: 1,
      };
    }
    if (!neighbours.data) return null;
    const sameOwner = neighbours.data.data.filter((row) =>
      isApp
        ? row.ownerType === "app" && row.appId === ownerId
        : row.ownerType !== "app" && row.agentId === ownerId,
    );
    const total = sameOwner.some((row) => row.id === call.id)
      ? sameOwner.length
      : sameOwner.length + 1;
    return {
      ...buildExcerptTimeline({ requests: [], toolCalls: sameOwner, call }),
      total,
    };
  }, [neighbours.data, call, isApp, ownerId]);

  const shown = excerpt?.timeline?.spans.length ?? 0;
  const truncated = neighbours.data?.pagination.hasNext === true;
  const ownerName = isApp
    ? (call.appName ?? "this app")
    : (agentName ?? "this MCP Gateway");

  return (
    <ExcerptCard
      call={call}
      timeline={excerpt?.timeline ?? null}
      loading={!neighbours.isError && excerpt === null}
      profileName={null}
      title="Nearby calls"
      countLabel={
        excerpt
          ? `Showing ${shown} of ${excerpt.total}${truncated ? "+" : ""}`
          : undefined
      }
      action={null}
      notice={
        neighbours.isError ? (
          <LoadFailedNotice onRetry={() => neighbours.refetch()} />
        ) : null
      }
      status={
        <>
          <OwnerLabel call={call} agentName={agentName} />
          <StatusPart>±15 min around this call</StatusPart>
          {excerpt ? (
            <StatusPart wideOnly>
              {excerpt.before} before · {excerpt.after} after
            </StatusPart>
          ) : null}
        </>
      }
      emptyNote={
        excerpt && shown <= 1
          ? `No other calls from ${ownerName} within 15 minutes.`
          : null
      }
    />
  );
}

/** The trimmed request list, and the session page's details pane under it. */
function ExcerptCard({
  call,
  timeline,
  loading,
  profileName,
  title,
  countLabel,
  action,
  notice,
  status,
  emptyNote,
}: {
  call: McpToolCallRecord;
  timeline: Timeline | null;
  loading: boolean;
  profileName: string | null;
  title: string;
  countLabel: string | undefined;
  action: ReactNode;
  notice: ReactNode;
  status: ReactNode;
  emptyNote?: string | null;
}) {
  const router = useRouter();
  const { displayByName: serverDisplayByName } = useMcpServerDisplayByName();
  const selfKey = toolCallSpanKey(call.id);
  const spans = timeline?.spans ?? [];
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [height, setHeight] = useState(DETAILS_PANE_DEFAULT_HEIGHT);

  const indexOfKey = (key: string | null) =>
    key ? spans.findIndex((span) => span.key === key) : -1;
  let selectedIndex = indexOfKey(pickedKey);
  if (selectedIndex < 0) selectedIndex = indexOfKey(selfKey);
  const selected = selectedIndex >= 0 ? spans[selectedIndex] : null;

  const step = (delta: number) => {
    if (spans.length === 0) return;
    const next = Math.min(spans.length - 1, Math.max(0, selectedIndex + delta));
    setPickedKey(spans[next].key);
  };
  const openSpan = (span: TimelineSpan) => {
    if (span.key === selfKey) return;
    router.push(
      span.type === "request"
        ? llmRequestHref(span.row)
        : `/mcp/logs/${span.call.id}`,
    );
  };

  return (
    // overflow-clip, not hidden, below lg: hidden would make the card a
    // scroll container and break the sticky pane headers. isolate keeps the
    // list's sticky column header under the page header.
    <section
      aria-label={title}
      className="isolate overflow-clip rounded-lg border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.03)] lg:overflow-hidden"
    >
      <RequestWaterfall
        timeline={timeline}
        loading={loading}
        profileName={profileName}
        serverDisplayByName={serverDisplayByName}
        conversationRowId={null}
        selectedKey={selected?.key ?? null}
        highlightedKey={selfKey}
        revealHighlighted={false}
        onSelect={setPickedKey}
        onOpen={openSpan}
        pagination={null}
        totalRequests={spans.length}
        title={title}
        countLabel={countLabel ?? ""}
        action={action}
        hideEmptyKinds
        notice={notice}
        status={status}
        emptyMessage="Nothing to show around this call."
      />
      {emptyNote ? (
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          {emptyNote}
        </p>
      ) : null}

      <SplitHandle height={height} onChange={setHeight} />

      {selected && selected.key !== selfKey ? (
        <div className="flex items-center gap-2 border-t bg-primary/[0.04] px-4 py-1.5 text-xs text-muted-foreground lg:border-t-0 lg:border-b">
          <span>Previewing a nearby record.</span>
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0"
            onClick={() => setPickedKey(selfKey)}
          >
            <span>Back to this call</span>
          </Button>
        </div>
      ) : null}
      <RequestDetails
        height={height}
        loading={loading}
        span={selected}
        origin={timeline?.origin ?? 0}
        previous={selectedIndex > 0 ? spans[selectedIndex - 1] : null}
        index={selectedIndex}
        count={spans.length}
        profileName={profileName}
        providerLabel={(provider) => provider}
        serverDisplayByName={serverDisplayByName}
        onStep={step}
        latestRequestId={null}
        onJumpToLatest={null}
        excerpt={{ currentKey: selfKey }}
      />
    </section>
  );
}

function StatusPart({
  children,
  wideOnly,
}: {
  children: ReactNode;
  wideOnly?: boolean;
}) {
  return (
    <span
      className={cn(
        "shrink-0 items-center gap-2",
        wideOnly ? "hidden lg:inline-flex" : "inline-flex",
      )}
    >
      <span aria-hidden="true" className="hidden h-3 w-px bg-border lg:block" />
      <span aria-hidden="true" className="lg:hidden">
        ·
      </span>
      <span>{children}</span>
    </span>
  );
}

function LoadFailedNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="border-b px-4 py-2.5">
      <InlineNotice variant="error">
        <TriangleAlert />
        <span className="font-medium">Nearby records didn't load</span>
        <Button
          variant="outline"
          size="xs"
          className="ml-auto"
          onClick={onRetry}
        >
          <span>Retry</span>
        </Button>
      </InlineNotice>
    </div>
  );
}

/** Epoch ms a record started: it is written when it finishes. */
function startOf(record: {
  createdAt: string;
  durationMs: number | null;
}): number {
  return (
    new Date(record.createdAt).getTime() - Math.max(0, record.durationMs ?? 0)
  );
}
