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
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import {
  useExportSessionInteractions,
  useInteraction,
  useInteractionSessions,
  useInteractionSummaries,
  useSessionLineage,
} from "@/lib/interactions/interaction.query";
import { LLM_LOG_FOCUS_PARAM } from "@/lib/interactions/llm-log-links";
import { useMcpServerDisplayByName } from "@/lib/mcp-logs/use-mcp-server-display";
import {
  GuardrailsProvider,
  TraceDetails,
  TraceWaterfall,
} from "./_parts/guardrails-context";
import { RequestDetails } from "./_parts/request-details";
import { RequestWaterfall } from "./_parts/request-waterfall";
import { SessionFacts } from "./_parts/session-facts";
import {
  SessionHeaderTitle,
  SessionIdentityLine,
} from "./_parts/session-header";
import {
  buildTimeline,
  requestSpanKey,
  type TimelineSpan,
  toolCallSpanKey,
} from "./_parts/session-timeline";
import {
  DETAILS_PANE_DEFAULT_HEIGHT,
  SplitHandle,
} from "./_parts/split-handle";
import { useLinkedRequest } from "./_parts/use-linked-request";
import { useSessionToolCalls } from "./_parts/use-session-tool-calls";

export default function SessionDetailPage({
  paramsPromise,
}: {
  paramsPromise: Promise<{ id: string }>;
}) {
  // The session key: a session id, or a sessionless request's own id.
  const sessionId = decodeURIComponent(use(paramsPromise).id);
  const router = useRouter();
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

  // Past page one, the read also takes the previous page's newest row: it
  // bounds this page's tool-call window, and a second read would delay them.
  const hasNewerPage = offset > 0;
  const { data: interactionsResponse, isLoading: interactionsLoading } =
    useInteractionSummaries({
      sessionId: sessionId,
      limit: hasNewerPage ? pageSize + 1 : pageSize,
      offset: hasNewerPage ? offset - 1 : offset,
      sortBy: "createdAt",
      sortDirection: "desc",
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

  const pageRows = interactionsResponse?.data ?? [];
  const newerRequest = hasNewerPage ? (pageRows[0] ?? null) : null;
  const interactions = useMemo(
    () => (hasNewerPage ? pageRows.slice(1) : pageRows),
    [hasNewerPage, pageRows],
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
  const sessionToolCalls = useSessionToolCalls({
    sessionId,
    requests: interactions,
    newerRequest,
    requestsReady: interactionsResponse !== undefined && !interactionsLoading,
    pageIndex,
    pageSize,
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
    interactionsLoading || !sessionToolCalls.ready || !linkedRequest.ready;

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
    () => buildTimeline({ requests: interactions, toolCalls }),
    [interactions, toolCalls],
  );
  const spans = timeline?.spans ?? [];
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [detailsHeight, setDetailsHeight] = useState(
    DETAILS_PANE_DEFAULT_HEIGHT,
  );

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

  // Requests are listed newest first, so the latest one lives on page one.
  const jumpToConversation =
    latestHasConversation && conversationRowId
      ? conversationOnPage
        ? () => setPickedKey(conversationKey)
        : pageIndex > 0
          ? () => {
              setPickedKey(conversationKey);
              goToPage(0);
            }
          : null
      : null;

  // A request's whole record is in the details pane; a tool call has a page.
  const openSpan = (span: TimelineSpan) => {
    if (span.type === "tool") router.push(`/mcp/logs/${span.call.id}`);
  };
  const exportDisabled = exportSession.isPending || totalRequests === 0;

  return (
    <TooltipProvider delayDuration={150}>
      <PageLayout
        denseContent
        title={
          <SessionHeaderTitle
            session={sessionData}
            title={sessionTitle || "Session"}
          />
        }
        documentTitle={sessionTitle || "Session"}
        stackHeaderOnMobile
        backLink={
          <span className="flex shrink-0 lg:translate-y-3">
            <PageBackLink href="/llm/logs">Back to Sessions</PageBackLink>
          </span>
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
              sessionId={sessionId}
              onSelectSpan={setPickedKey}
            >
              <TraceWaterfall
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
                onOpen={openSpan}
                openHint="Enter or double-click opens a tool call"
                notice={
                  <ToolCallsNotice
                    failed={sessionToolCalls.isError}
                    onRetry={() => sessionToolCalls.refetch()}
                    truncated={sessionToolCalls.truncated}
                    missingToolCallId={
                      sessionToolCalls.targetMissing ? targetToolCallId : null
                    }
                    missingRequest={linkedRequest.targetMissing}
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
              <SplitHandle height={detailsHeight} onChange={setDetailsHeight} />
              <TraceDetails
                height={detailsHeight}
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

/** What the request list cannot show about this page's records, if anything. */
function ToolCallsNotice({
  failed,
  onRetry,
  truncated,
  missingToolCallId,
  missingRequest,
}: {
  failed: boolean;
  onRetry: () => void;
  truncated: boolean;
  missingToolCallId: string | null;
  missingRequest: boolean;
}) {
  if (!failed && !truncated && !missingToolCallId && !missingRequest) {
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
