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
import { use, useCallback, useMemo, useRef, useState } from "react";
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
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import {
  useExportSessionInteractions,
  useInteraction,
  useInteractionSessions,
  useInteractionSummaries,
  useSessionChatErrors,
  useSessionLineage,
} from "@/lib/interactions/interaction.query";
import {
  LLM_LOG_FOCUS_PARAM,
  llmSessionHref,
} from "@/lib/interactions/llm-log-links";
import { useMcpServerDisplayByName } from "@/lib/mcp-logs/use-mcp-server-display";
import {
  GuardrailsProvider,
  TraceDetails,
  TraceWaterfall,
} from "./_parts/guardrails-context";
import {
  type SessionChatError,
  SessionChatErrors,
} from "./_parts/session-chat-errors";
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
  // Where this page's records end: the next page's first request's start.
  // Without that boundary, the page's own last request bounds it.
  const pageEndsAt = nextRequest
    ? new Date(nextRequest.createdAt).getTime() -
      Math.max(0, nextRequest.durationMs ?? 0)
    : hasNextPage && interactions.length > 0
      ? Math.max(
          ...interactions.map((row) => new Date(row.createdAt).getTime()),
        )
      : null;
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
  // Read only for a session whose chat showed errors, so other sessions do
  // not pay for a request that would come back empty.
  const { data: chatErrors = NO_CHAT_ERRORS } = useSessionChatErrors({
    sessionId,
    enabled: (sessionData?.chatErrorCount ?? 0) > 0,
  });
  const requestIdByChatErrorId = useMemo(
    () =>
      lastRequestBeforeEachError({
        chatErrors,
        requests: interactions,
        nextRequest: hasNextPage ? nextRequest : null,
      }),
    [chatErrors, interactions, hasNextPage, nextRequest],
  );
  const chatErrorsByRowId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const requestId of requestIdByChatErrorId.values()) {
      counts.set(requestId, (counts.get(requestId) ?? 0) + 1);
    }
    return counts;
  }, [requestIdByChatErrorId]);

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

  const timeline = useMemo(
    () => buildTimeline({ requests: interactions, toolCalls, sessionStart }),
    [interactions, toolCalls, sessionStart],
  );
  const spans = timeline?.spans ?? [];
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const requestsSectionRef = useRef<HTMLElement>(null);

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
            status={sessionData ?? null}
          />

          <SessionChatErrors
            chatErrors={chatErrors}
            requestIdByErrorId={requestIdByChatErrorId}
            onShowRequest={(requestId) => {
              if (!interactions.some((row) => row.id === requestId)) {
                openRequest(requestId);
                return;
              }
              // The list keeps its selected row in view; bring the list
              // itself into the page's view, or the click seems to do nothing.
              setPickedKey(requestSpanKey(requestId));
              requestsSectionRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
            }}
          />

          {/* overflow-clip, not hidden, below lg: hidden would make the card
              a scroll container and break the sticky pane headers. isolate
              keeps the list's sticky column header under the page header. */}
          <section
            ref={requestsSectionRef}
            aria-label="Requests and request details"
            className="isolate overflow-clip rounded-lg border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.03)] lg:overflow-hidden"
          >
            <GuardrailsProvider
              timeline={timeline}
              pageEndsAt={pageEndsAt}
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
                chatErrorsByRowId={chatErrorsByRowId}
                onSelect={setPickedKey}
                notice={
                  <ToolCallsNotice
                    failed={sessionToolCalls.isError}
                    onRetry={() => sessionToolCalls.refetch()}
                    truncated={sessionToolCalls.truncated}
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

const NO_CHAT_ERRORS: SessionChatError[] = [];

/**
 * Ties each chat error to the request logged last before it on this page: the
 * turn the chat was running when it failed. An error past the next page's
 * first request belongs to a later page, and one before this page's first
 * request to an earlier one; neither is tied.
 */
function lastRequestBeforeEachError({
  chatErrors,
  requests,
  nextRequest,
}: {
  chatErrors: SessionChatError[];
  requests: { id: string; createdAt: string }[];
  nextRequest: { createdAt: string } | null;
}): Map<string, string> {
  const tied = new Map<string, string>();
  const nextAt = nextRequest ? new Date(nextRequest.createdAt).getTime() : null;
  for (const chatError of chatErrors) {
    const at = new Date(chatError.createdAt).getTime();
    if (nextAt !== null && nextAt <= at) continue;
    let match: string | null = null;
    for (const request of requests) {
      if (new Date(request.createdAt).getTime() > at) break;
      match = request.id;
    }
    if (match) tied.set(chatError.id, match);
  }
  return tied;
}

/** What the request list cannot show about this page's records, if anything. */
function ToolCallsNotice({
  failed,
  onRetry,
  truncated,
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
