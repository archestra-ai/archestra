"use client";

import { DynamicInteraction } from "@archestra/shared";
import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  Info,
  Loader2,
  LockKeyhole,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { use, useCallback, useMemo, useState } from "react";
import { sessionTitleOf } from "@/app/llm/logs/_parts/logs-table-format";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import {
  useExportSessionInteractions,
  useHandedOffRecords,
  useInteraction,
  useInteractionSessions,
  useInteractionSummaries,
  useSessionHandoffs,
  useSessionLineage,
} from "@/lib/interactions/interaction.query";
import {
  LLM_LOG_FOCUS_PARAM,
  llmSessionHref,
} from "@/lib/interactions/llm-log-links";
import { useMcpServerDisplayByName } from "@/lib/mcp-logs/use-mcp-server-display";
import { useModelPools } from "@/lib/model-pools.query";
import {
  GuardrailsProvider,
  TraceDetails,
  TraceWaterfall,
} from "./_parts/guardrails-context";
import { mergedRecordsQuery, pageEndsAt } from "./_parts/page-window";
import { buildRanOn, type SessionHandoffs } from "./_parts/ran-on";
import type { RanOnParties } from "./_parts/ran-on-strip";
import { SessionFacts } from "./_parts/session-facts";
import {
  SessionHeaderIcon,
  SessionIdentityLine,
} from "./_parts/session-header";
import {
  buildTimeline,
  requestSpanKey,
  toolCallSpanKey,
} from "./_parts/session-timeline";
import { DETAILS_PANE_DEFAULT_HEIGHT } from "./_parts/split-handle";
import { useLinkedRequest } from "./_parts/use-linked-request";
import { useSessionToolCalls } from "./_parts/use-session-tool-calls";

export default function SessionDetailPage({
  paramsPromise,
}: {
  paramsPromise: Promise<{ id: string }>;
}) {
  // The session key: a session id, or a sessionless request's own id.
  const sessionId = decodeURIComponent(use(paramsPromise).id);
  const appName = useAppName();
  const openappaEnabled = useFeature("openappaEnabled") === true;
  const { pageIndex, pageSize, offset, setPagination } =
    useDataTableQueryParams({ defaultPageSize: 50 });
  const { label: providerLabel } = useModelProviderCatalog();
  const { displayByName: serverDisplayByName } = useMcpServerDisplayByName();
  // Links preselect one record: a tool call from `/mcp/logs`, or a request.
  const searchParams = useSearchParams();
  const targetToolCallId = searchParams.get(LLM_LOG_FOCUS_PARAM.toolCall);
  const targetRequestId = searchParams.get(LLM_LOG_FOCUS_PARAM.request);

  // Requests run oldest first, so page one is where the session began.
  const { data: interactionsResponse, isLoading: interactionsLoading } =
    useInteractionSummaries({
      sessionId: sessionId,
      limit: pageSize,
      offset,
      sortBy: "createdAt",
      sortDirection: "asc",
    });
  // The next page's oldest row bounds this page's tool-call window. It is its
  // own read: the list endpoint caps a page at 100 rows, so a 100-row page
  // has no room for it.
  const hasNextPage =
    interactionsResponse !== undefined &&
    offset + pageSize < interactionsResponse.pagination.total;
  const nextPageHead = useInteractionSummaries({
    sessionId,
    limit: 1,
    offset: offset + pageSize,
    sortBy: "createdAt",
    sortDirection: "asc",
    enabled: hasNextPage,
  });

  // Fetch session metadata (profile name, user names, etc.)
  const {
    data: sessionResponse,
    isLoadingError: sessionLoadingError,
    refetch: refetchSession,
  } = useInteractionSessions({
    sessionId: sessionId,
    limit: 1,
    toastOnError: false,
  });

  // Past page one, the session's first request: the axis counts from it.
  // Should it fail, the axis falls back to counting from this page's start.
  const firstPageHead = useInteractionSummaries({
    sessionId,
    limit: 1,
    offset: 0,
    sortBy: "createdAt",
    sortDirection: "asc",
    enabled: offset > 0,
  });
  const firstRow = offset > 0 ? (firstPageHead.data?.data[0] ?? null) : null;
  const sessionStartPending = offset > 0 && firstPageHead.isPending;
  const sessionStartFailed = offset > 0 && firstPageHead.isError;
  const sessionStart = firstRow
    ? new Date(firstRow.createdAt).getTime() -
      Math.max(0, firstRow.durationMs ?? 0)
    : null;

  const interactions = useMemo(
    () => interactionsResponse?.data ?? [],
    [interactionsResponse],
  );
  const nextRequest = hasNextPage ? (nextPageHead.data?.data[0] ?? null) : null;
  const pageEnd = pageEndsAt({
    requests: interactions,
    nextRequest,
    hasNextPage,
  });
  const requestsReady =
    interactionsResponse !== undefined &&
    !interactionsLoading &&
    (!hasNextPage || !nextPageHead.isPending);
  const lastPageIndex = Math.max(
    0,
    Math.ceil((interactionsResponse?.pagination.total ?? 0) / pageSize) - 1,
  );
  const paginationMeta = interactionsResponse?.pagination;
  const sessionData = sessionResponse?.data?.[0];
  const { data: lineage } = useSessionLineage({
    sessionId,
    enabled: openappaEnabled,
  });

  // Use session data from API for accurate totals, fall back to page data
  const totalInputTokens =
    sessionData?.totalInputTokens ??
    interactions.reduce((sum, i) => sum + (i.inputTokens ?? 0), 0);
  const totalOutputTokens =
    sessionData?.totalOutputTokens ??
    interactions.reduce((sum, i) => sum + (i.outputTokens ?? 0), 0);
  const totalCacheReadTokens =
    sessionData?.totalCacheReadTokens ??
    interactions.reduce((sum, i) => sum + (i.cacheReadTokens ?? 0), 0);
  const totalCacheWriteTokens =
    sessionData?.totalCacheWriteTokens ??
    interactions.reduce((sum, i) => sum + (i.cacheWriteTokens ?? 0), 0);
  const models = sessionData?.models ?? [
    ...new Set(
      interactions.flatMap((interaction) =>
        interaction.model ? [interaction.model] : [],
      ),
    ),
  ];
  const firstRequest = sessionData?.firstRequestTime ?? null;
  const lastRequest = sessionData?.lastRequestTime ?? null;
  const totalRequests =
    sessionData?.requestCount ?? paginationMeta?.total ?? interactions.length;
  const totalCost = sessionData?.totalCost;
  const totalBilledCost = sessionData?.totalBilledCost;
  const totalSubscriptionCost = sessionData?.totalSubscriptionCost;
  const totalBaselineCost = sessionData?.totalBaselineCost;

  const profileName = sessionData?.profileName ?? null;

  const sessionTitle = sessionData ? sessionTitleOf(sessionData) : null;

  const exportSession = useExportSessionInteractions();

  const goToPage = useCallback(
    (nextPageIndex: number) =>
      setPagination({ pageIndex: nextPageIndex, pageSize }),
    [setPagination, pageSize],
  );
  // A request on another page opens as a link, which finds its page.
  const router = useRouter();
  const openRequest = useCallback(
    (requestId: string) =>
      router.push(
        `${llmSessionHref(sessionId, { request: requestId })}&pageSize=${pageSize}`,
        { scroll: false },
      ),
    [router, sessionId, pageSize],
  );
  const sessionToolCalls = useSessionToolCalls({
    sessionId,
    requests: interactions,
    nextRequest,
    boundary: {
      failed: hasNextPage && nextPageHead.isError,
      retry: () => nextPageHead.refetch(),
    },
    requestsReady,
    pageIndex,
    pageSize,
    lastPageIndex,
    onLocatePage: goToPage,
    targetToolCallId,
  });
  const { toolCalls } = sessionToolCalls;
  // Work this session handed to Agent Runtime ran under the run's own
  // session; its requests and calls in this page's time range join the trace.
  const { data: allHandoffs } = useSessionHandoffs({ sessionId });
  // At most a few runs join the trace; the rest are listed, not drawn.
  const handoffs = useMemo(() => capHandoffs(allHandoffs), [allHandoffs]);
  const omittedRuns = allHandoffs?.handedTo.slice(MAX_MERGED_RUNS) ?? [];
  const mergedRuns = handoffs?.handedTo ?? [];
  const handedOff = useHandedOffRecords({
    sessionIds: mergedRuns.map((run) => run.llmSessionId),
    ...mergedRecordsQuery({ offset, requests: interactions, nextRequest }),
  });
  const failedRuns = mergedRuns.filter((run) =>
    handedOff.failedSessionIds.includes(run.llmSessionId),
  );
  const linkedRequest = useLinkedRequest({
    sessionId,
    requests: interactions,
    requestsReady: interactionsResponse !== undefined && !interactionsLoading,
    pageIndex,
    pageSize,
    onLocatePage: goToPage,
    targetRequestId,
  });

  // The trace draws once: this page's requests and tool calls, on the page a
  // link points at. Drawing each as it lands reflows the rows and moves the
  // selection.
  const traceLoading =
    interactionsLoading ||
    handedOff.pending ||
    sessionStartPending ||
    !sessionToolCalls.ready ||
    !linkedRequest.ready;

  // Whether the latest main request captured a thread: its thread is the
  // whole conversation, so the list marks it and the details offer a way to
  // it. The full record can run to megabytes, so it waits for the trace.
  const latestInteractionId = sessionData?.lastInteractionId ?? undefined;
  const { data: lastMainRequest } = useInteraction({
    interactionId: latestInteractionId,
    refetchInterval: null,
    enabled: latestInteractionId !== undefined && !traceLoading,
  });
  const latestHasConversation = useMemo(
    () =>
      lastMainRequest
        ? new DynamicInteraction(lastMainRequest).mapToUiMessages().length > 0
        : false,
    [lastMainRequest],
  );

  const traceRequests = useMemo(
    () => byCreatedAt([...interactions, ...handedOff.requests]),
    [interactions, handedOff.requests],
  );
  const traceToolCalls = useMemo(
    () => byCreatedAt([...toolCalls, ...handedOff.toolCalls]),
    [toolCalls, handedOff.toolCalls],
  );

  const timeline = useMemo(
    () =>
      buildTimeline({
        requests: traceRequests,
        toolCalls: traceToolCalls,
        sessionStart,
      }),
    [traceRequests, traceToolCalls, sessionStart],
  );
  const ranOnView = useMemo(
    () => buildRanOn({ timeline, handoffs: handoffs ?? undefined, sessionId }),
    [timeline, handoffs, sessionId],
  );
  // The run's own session names the client it came from.
  const originSessionId = handoffs?.handedFrom?.originLlmSessionId;
  const { data: originSession } = useInteractionSessions({
    sessionId: originSessionId ?? "",
    limit: 1,
    toastOnError: false,
    enabled: originSessionId !== undefined,
  });
  const handoffRuns = handoffs
    ? handoffs.handedTo.length > 0
      ? handoffs.handedTo
      : handoffs.handedFrom
        ? [handoffs.handedFrom]
        : []
    : [];
  const ranOn =
    ranOnView && handoffRuns.length > 0
      ? {
          view: ranOnView,
          parties: {
            clientLabel:
              (ranOnView.side === "client"
                ? sessionData?.externalAgentIdLabels[0]
                : originSession?.data[0]?.externalAgentIdLabels[0]) ?? "Client",
            runs: handoffRuns.map((run) => ({
              runId: run.runId,
              agentName: run.agentName,
              href: runHref(run.runId),
            })),
            origin: originSessionId
              ? {
                  label:
                    originSession?.data[0]?.externalAgentIdLabels[0] ??
                    "Client",
                  href: llmSessionHref(originSessionId),
                }
              : null,
          } satisfies RanOnParties,
        }
      : null;

  // A pooled row names the member key it went to.
  const poolsEnabled = useFeature("llmModelPoolsEnabled") === true;
  const { data: canReadPools } = useHasPermissions({ llmModel: ["read"] });
  const hasPooledRows = traceRequests.some((row) => row.modelPoolId);
  const { data: pools } = useModelPools({
    enabled: poolsEnabled && Boolean(canReadPools) && hasPooledRows,
    toastOnError: false,
  });
  const poolKeyNames = useMemo(
    () =>
      new Map(
        (pools ?? []).flatMap((pool) =>
          pool.members.map(
            (member) =>
              [member.providerApiKeyId, member.providerApiKeyName] as const,
          ),
        ),
      ),
    [pools],
  );
  const spans = timeline?.spans ?? [];
  const [pickedKey, setPickedKey] = useState<string | null>(null);

  const unavailableSession =
    sessionResponse !== undefined && sessionResponse.data.length === 0;

  if (sessionLoadingError) {
    return (
      <PageLayout
        denseContent
        title="Session"
        backLink={
          <PageBackLink href="/llm/logs">Back to Sessions</PageBackLink>
        }
      >
        <QueryLoadError
          title="Couldn't load this session"
          onRetry={() => refetchSession()}
        />
      </PageLayout>
    );
  }

  if (unavailableSession) {
    return (
      <div className="flex h-full min-h-0 w-full items-center justify-center overflow-y-auto p-6">
        <title>{`Session unavailable - ${appName}`}</title>
        <Empty className="flex-none py-12 md:py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyhole aria-hidden="true" />
            </EmptyMedia>
            <div role="alert" className="space-y-2">
              <h1 className="text-lg font-medium tracking-tight">
                Session unavailable
              </h1>
              <EmptyDescription>
                You may not have permission to view this session, or it may no
                longer exist.
              </EmptyDescription>
            </div>
          </EmptyHeader>
          <EmptyContent>
            <p className="text-sm text-muted-foreground">
              If someone shared this link with you, ask an administrator to
              check your log access.
            </p>
            <Button variant="outline" asChild>
              <Link href="/llm/logs">
                <ArrowLeft aria-hidden="true" />
                <span>Back to Sessions</span>
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const conversationRowId = sessionData?.lastInteractionId ?? null;
  const conversationKey = conversationRowId
    ? requestSpanKey(conversationRowId)
    : null;
  const linkedKey =
    targetToolCallId && sessionToolCalls.targetOnPage
      ? toolCallSpanKey(targetToolCallId)
      : targetRequestId && linkedRequest.targetOnPage
        ? requestSpanKey(targetRequestId)
        : null;
  // Selection falls back to the record the URL linked to, then to the latest
  // request, whose thread is the whole conversation, then to the newest record.
  const indexOfKey = (key: string | null) =>
    key ? spans.findIndex((span) => span.key === key) : -1;
  let selectedIndex = indexOfKey(pickedKey);
  if (selectedIndex < 0) selectedIndex = indexOfKey(linkedKey);
  if (selectedIndex < 0) selectedIndex = indexOfKey(conversationKey);
  if (selectedIndex < 0) selectedIndex = spans.length - 1;
  const selected = selectedIndex >= 0 ? spans[selectedIndex] : null;
  const conversationOnPage = indexOfKey(conversationKey) >= 0;

  const step = (delta: number) => {
    if (spans.length === 0) return;
    const next = Math.min(spans.length - 1, Math.max(0, selectedIndex + delta));
    setPickedKey(spans[next].key);
  };

  // Requests run oldest first, so the latest one lives on the last page.
  const jumpToConversation =
    latestHasConversation && conversationRowId
      ? conversationOnPage
        ? () => setPickedKey(conversationKey)
        : pageIndex !== lastPageIndex
          ? () => {
              setPickedKey(conversationKey);
              goToPage(lastPageIndex);
            }
          : null
      : null;

  const exportDisabled = exportSession.isPending || totalRequests === 0;

  return (
    <TooltipProvider delayDuration={150}>
      <PageLayout
        denseContent
        // Laid out like every other detail page: back arrow, the record's
        // mark in its tile, then the title over its one-line description.
        icon={<SessionHeaderIcon session={sessionData} />}
        title={
          // Block, or truncate does nothing: an inline span keeps the whole
          // first prompt on one line and the page scrolls sideways.
          <span className="block truncate" title={sessionTitle || "Session"}>
            {sessionTitle || "Session"}
          </span>
        }
        documentTitle={sessionTitle || "Session"}
        stackHeaderOnMobile
        backLink={
          <PageBackLink href="/llm/logs">Back to Sessions</PageBackLink>
        }
        description={<SessionIdentityLine session={sessionData} />}
      >
        <div className="space-y-4">
          <SessionFacts
            totals={{
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cacheReadTokens: totalCacheReadTokens,
              cacheWriteTokens: totalCacheWriteTokens,
              cost: totalCost,
              billedCost: totalBilledCost,
              subscriptionCost: totalSubscriptionCost,
              baselineCost: totalBaselineCost,
            }}
            totalRequests={totalRequests}
            rows={interactions}
            models={models}
            firstRequest={firstRequest}
            lastRequest={lastRequest}
            fallbackType={sessionData?.lastInteractionType ?? null}
            providerLabel={providerLabel}
            trajectory={
              openappaEnabled ? { session: sessionData, lineage } : null
            }
          />

          {/* overflow-clip, not hidden, below lg: hidden would make the card
              a scroll container and break the sticky pane headers. isolate
              keeps the list's sticky column header under the page header. */}
          <section
            aria-label="Requests and request details"
            className="isolate overflow-clip rounded-lg border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.03)] lg:overflow-hidden"
          >
            <GuardrailsProvider
              timeline={timeline}
              pageEndsAt={pageEnd}
              sessionId={sessionId}
              onSelectSpan={setPickedKey}
            >
              <TraceWaterfall
                onOpenRequest={openRequest}
                timeline={timeline}
                loading={traceLoading}
                profileName={profileName}
                serverDisplayByName={serverDisplayByName}
                conversationRowId={
                  latestHasConversation ? conversationRowId : null
                }
                selectedKey={selected?.key ?? null}
                highlightedKey={linkedKey}
                onSelect={setPickedKey}
                ranOn={ranOn}
                poolKeyNames={poolKeyNames}
                notice={
                  <ToolCallsNotice
                    failed={sessionToolCalls.isError}
                    onRetry={() => sessionToolCalls.refetch()}
                    truncated={sessionToolCalls.truncated}
                    handedOffTruncated={handedOff.truncated}
                    omittedRuns={omittedRuns}
                    moreRunsOmitted={allHandoffs?.handedToTruncated ?? false}
                    failedRuns={failedRuns}
                    onRetryFailedRuns={handedOff.retry}
                    missingToolCallId={
                      sessionToolCalls.targetMissing ? targetToolCallId : null
                    }
                    missingRequest={linkedRequest.targetMissing}
                    requestLookupFailed={linkedRequest.rankFailed}
                    onRetryRequestLookup={linkedRequest.retry}
                    toolCallLookupFailed={sessionToolCalls.rankFailed}
                    onRetryToolCallLookup={sessionToolCalls.retryRank}
                    sessionStartFailed={sessionStartFailed}
                    onRetrySessionStart={() => firstPageHead.refetch()}
                  />
                }
                pagination={
                  paginationMeta && paginationMeta.total > 0
                    ? {
                        pageIndex,
                        pageSize,
                        offset,
                        total: paginationMeta.total,
                        onPaginationChange: setPagination,
                      }
                    : null
                }
                totalRequests={totalRequests}
                action={
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => exportSession.mutate({ sessionId })}
                    disabled={exportDisabled}
                  >
                    {exportSession.isPending ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Download aria-hidden="true" />
                    )}
                    {/* Phones show the glyph alone beside the card's title. */}
                    <span className="max-lg:sr-only">Export JSON</span>
                  </Button>
                }
              />
              <div className="hidden h-px bg-border lg:block" />
              <TraceDetails
                height={DETAILS_PANE_DEFAULT_HEIGHT}
                loading={traceLoading}
                span={traceLoading ? null : selected}
                origin={timeline?.origin ?? 0}
                previous={selectedIndex > 0 ? spans[selectedIndex - 1] : null}
                index={selectedIndex}
                count={spans.length}
                profileName={profileName}
                providerLabel={providerLabel}
                serverDisplayByName={serverDisplayByName}
                onStep={step}
                latestRequestId={conversationRowId}
                onJumpToLatest={jumpToConversation}
                requests={traceRequests}
              />
            </GuardrailsProvider>
          </section>
        </div>
      </PageLayout>
    </TooltipProvider>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/** What the request list cannot show about this page's records, if anything. */
function ToolCallsNotice({
  failed,
  onRetry,
  truncated,
  handedOffTruncated,
  omittedRuns,
  moreRunsOmitted,
  failedRuns,
  onRetryFailedRuns,
  missingToolCallId,
  missingRequest,
  requestLookupFailed,
  onRetryRequestLookup,
  toolCallLookupFailed,
  onRetryToolCallLookup,
  sessionStartFailed,
  onRetrySessionStart,
}: {
  failed: boolean;
  onRetry: () => void;
  truncated: boolean;
  /** The Agent Runtime records merged into this page were capped. */
  handedOffTruncated: boolean;
  /** Runs this session started that the trace leaves out. */
  omittedRuns: { runId: string; agentName: string; title: string | null }[];
  /** The session started even more runs than were listed. */
  moreRunsOmitted: boolean;
  /** Merged runs whose records did not load. */
  failedRuns: { runId: string; agentName: string }[];
  onRetryFailedRuns: () => void;
  missingToolCallId: string | null;
  missingRequest: boolean;
  /** Finding the linked request's page failed. */
  requestLookupFailed: boolean;
  onRetryRequestLookup: () => void;
  /** Finding the linked tool call's page failed. */
  toolCallLookupFailed: boolean;
  onRetryToolCallLookup: () => void;
  /** The session's first request didn't load, so the axis counts from this page. */
  sessionStartFailed: boolean;
  onRetrySessionStart: () => void;
}) {
  if (
    !failed &&
    !truncated &&
    !handedOffTruncated &&
    omittedRuns.length === 0 &&
    failedRuns.length === 0 &&
    !missingToolCallId &&
    !missingRequest &&
    !requestLookupFailed &&
    !toolCallLookupFailed &&
    !sessionStartFailed
  ) {
    return null;
  }
  return (
    <div className="space-y-2 border-b px-4 py-2">
      {failed ? (
        <InlineNotice variant="error">
          <TriangleAlert />
          <span className="font-medium">Tool calls didn't load</span>
          <InlineNoticeText>
            The requests are complete; the MCP tool calls between them are
            missing.
          </InlineNoticeText>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={onRetry}
          >
            <span>Retry</span>
          </Button>
        </InlineNotice>
      ) : null}
      {requestLookupFailed ? (
        <InlineNotice variant="error">
          <TriangleAlert />
          <InlineNoticeText>
            Couldn't find the page that holds the linked request.
          </InlineNoticeText>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={onRetryRequestLookup}
          >
            <span>Retry</span>
          </Button>
        </InlineNotice>
      ) : null}
      {toolCallLookupFailed ? (
        <InlineNotice variant="error">
          <TriangleAlert />
          <InlineNoticeText>
            Couldn't find the page that holds the linked tool call.
          </InlineNoticeText>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={onRetryToolCallLookup}
          >
            <span>Retry</span>
          </Button>
        </InlineNotice>
      ) : null}
      {sessionStartFailed ? (
        <InlineNotice variant="neutral">
          <InlineNoticeText>
            Times on the axis count from this page's first request: the
            session's start didn't load.
          </InlineNoticeText>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={onRetrySessionStart}
          >
            <span>Retry</span>
          </Button>
        </InlineNotice>
      ) : null}
      {/* A cap, not a problem: one quiet line. */}
      {truncated ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Showing the latest 100 tool calls in this page's time range. A
            smaller page size shows them all.
          </span>
        </p>
      ) : null}
      {handedOffTruncated ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Showing the first 100 Agent Runtime requests in this page's time
            range. The run's own session has them all.
          </span>
        </p>
      ) : null}
      {omittedRuns.length > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span>
              This trace shows the first {MAX_MERGED_RUNS} Agent Runtime runs.
              Open the others:{" "}
            </span>
            {omittedRuns.map((run, i) => (
              <span key={run.runId}>
                {i > 0 ? <span>, </span> : null}
                <Link
                  href={runHref(run.runId)}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {run.title ?? run.agentName}
                </Link>
              </span>
            ))}
            {moreRunsOmitted ? <span>, and more</span> : null}
          </span>
        </p>
      ) : null}
      {failedRuns.length > 0 ? (
        <InlineNotice variant="error">
          <TriangleAlert />
          <span className="font-medium">Agent Runtime records didn't load</span>
          <InlineNoticeText>
            {`${failedRuns.map((run) => run.agentName).join(", ")}: ${failedRuns.length === 1 ? "its" : "their"} requests and tool calls are missing from this trace.`}
          </InlineNoticeText>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={onRetryFailedRuns}
          >
            <span>Retry</span>
          </Button>
        </InlineNotice>
      ) : null}
      {missingToolCallId ? (
        <InlineNotice variant="neutral">
          <InlineNoticeText>
            The linked tool call isn't among this page's records.
          </InlineNoticeText>
          <Button variant="outline" size="xs" className="ml-auto" asChild>
            <Link href={`/mcp/logs/${missingToolCallId}`}>
              <span>Open tool call</span>
              <ArrowUpRight />
            </Link>
          </Button>
        </InlineNotice>
      ) : null}
      {missingRequest ? (
        <InlineNotice variant="neutral">
          <InlineNoticeText>
            The linked request isn't one of this session's requests.
          </InlineNoticeText>
        </InlineNotice>
      ) : null}
    </div>
  );
}

/** Runs whose records join a client's trace; later ones stay one click away. */
const MAX_MERGED_RUNS = 3;

function runHref(runId: string): string {
  return `/chat/runs/${runId}`;
}

/** Keeps the first runs and only the moves between the client and them. */
function capHandoffs(
  handoffs: SessionHandoffs | null | undefined,
): SessionHandoffs | null {
  if (!handoffs || handoffs.handedTo.length <= MAX_MERGED_RUNS) {
    return handoffs ?? null;
  }
  const handedTo = handoffs.handedTo.slice(0, MAX_MERGED_RUNS);
  const kept = new Set(handedTo.map((run) => run.runId));
  if (handoffs.handedFrom) kept.add(handoffs.handedFrom.runId);
  return {
    ...handoffs,
    handedTo,
    moves: handoffs.moves.filter((move) => kept.has(move.runId)),
  };
}

function byCreatedAt<T extends { createdAt: string }>(records: T[]): T[] {
  return [...records].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}
