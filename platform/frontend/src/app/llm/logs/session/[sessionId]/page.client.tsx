"use client";

import {
  clientForExternalAgentIds,
  DynamicInteraction,
} from "@archestra/shared";
import { Bot, Download, Layers, Loader2, User } from "lucide-react";
import { useRouter } from "next/navigation";
import { use } from "react";
import { BackLink } from "@/components/agent-pages/agent-page-shell";
import { BilledCost } from "@/components/billed-cost";
import { ClientSourceBadge } from "@/components/client-source-badge";
import { type DetailFact, DetailFacts } from "@/components/detail-facts";
import { LoadingState } from "@/components/loading";
import MessageThread from "@/components/message-thread";
import { PageLayout } from "@/components/page-layout";
import { SourceBadge } from "@/components/source-badge";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TablePagination } from "@/components/ui/table-pagination";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UnattributedUserBadge } from "@/components/unattributed-user-badge";
import { VirtualKeyBadge } from "@/components/virtual-key-badge";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { typeRole } from "@/lib/design/type-scale";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  useExportSessionInteractions,
  useInteractionSessions,
  useInteractions,
} from "@/lib/interactions/interaction.query";
import { cn, formatDate } from "@/lib/utils";

export default function SessionDetailPage({
  paramsPromise,
}: {
  paramsPromise: Promise<{ sessionId: string }>;
}) {
  const rawParams = use(paramsPromise);
  const sessionId = decodeURIComponent(rawParams.sessionId);
  const router = useRouter();
  const { pageIndex, pageSize, offset, setPagination } =
    useDataTableQueryParams();

  const { data: interactionsResponse, isLoading: interactionsLoading } =
    useInteractions({
      sessionId: sessionId,
      limit: pageSize,
      offset,
      sortBy: "createdAt",
      sortDirection: "desc",
    });

  // Fetch session metadata (profile name, user names, etc.)
  const { data: sessionResponse } = useInteractionSessions({
    sessionId: sessionId,
    limit: 1,
  });

  // Fetch the most recent interactions for the inline "Latest Conversation"
  // block. This is intentionally decoupled from the table's pagination: offset
  // is always 0, and the limit is a fixed small window (not the user-selectable
  // pageSize) so changing rows-per-page never alters this query. We fetch a
  // window rather than a single row because the block shows the latest *main*
  // request, and the newest interactions by createdAt may be subagent calls
  // (see lastMainRequest find below) — requestType isn't filterable server-side.
  const { data: latestConversationResponse } = useInteractions({
    sessionId: sessionId,
    limit: DEFAULT_TABLE_LIMIT,
    offset: 0,
    sortBy: "createdAt",
    sortDirection: "desc",
  });

  const interactions = interactionsResponse?.data ?? [];
  const paginationMeta = interactionsResponse?.pagination;
  const sessionData = sessionResponse?.data?.[0];
  const latestInteractions = latestConversationResponse?.data ?? [];

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
    ...new Set(interactions.map((i) => i.model).filter(Boolean)),
  ];
  const firstRequest = sessionData?.firstRequestTime ?? null;
  const lastRequest = sessionData?.lastRequestTime ?? null;
  const totalRequests =
    sessionData?.requestCount ?? paginationMeta?.total ?? interactions.length;
  const totalCost = sessionData?.totalCost;
  const totalBilledCost = sessionData?.totalBilledCost;
  const totalSubscriptionCost = sessionData?.totalSubscriptionCost;
  const totalBaselineCost = sessionData?.totalBaselineCost;
  const totalToonCostSavings = sessionData?.totalToonCostSavings;

  // Session metadata from API
  // Badge for known clients (Claude, Codex); null for non-client agent ids.
  // Derived from the client-attribution column (external_agent_id).
  const clientSource = clientForExternalAgentIds(
    sessionData?.externalAgentIds ?? [],
  );
  const profileName = sessionData?.profileName;
  const userNames = sessionData?.userNames ?? [];

  // Session title: prefer claudeCodeTitle or conversationTitle, fall back to first user message
  const getSessionTitle = () => {
    if (sessionData?.claudeCodeTitle) return sessionData.claudeCodeTitle;
    if (sessionData?.conversationTitle) return sessionData.conversationTitle;

    // Fall back to first meaningful user message from current page
    const sortedInteractions = [...interactions].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    for (const interaction of sortedInteractions) {
      const dynamicInteraction = new DynamicInteraction(interaction);
      const userMessage = dynamicInteraction.getLastUserMessage();
      if (
        userMessage &&
        !userMessage.includes("Please write a 5-10 word title") &&
        userMessage.length > 10
      ) {
        return userMessage.length > 100
          ? `${userMessage.slice(0, 100)}...`
          : userMessage;
      }
    }
    return null;
  };

  const sessionTitle = getSessionTitle();

  const exportSession = useExportSessionInteractions();

  // Find the last main request (requestType === "main" or first in delegation
  // chain) from the most recent interactions. This drives the inline
  // "Latest Conversation" block.
  const lastMainRequest = latestInteractions.find((interaction) => {
    const requestType =
      "requestType" in interaction
        ? (interaction.requestType ?? "main")
        : "main";
    const externalAgentIdLabel =
      "externalAgentIdLabel" in interaction
        ? interaction.externalAgentIdLabel
        : undefined;
    // Main request or has no delegation (externalAgentIdLabel without "→")
    return (
      requestType === "main" ||
      (externalAgentIdLabel && !externalAgentIdLabel.includes("→"))
    );
  });

  // Build the conversation thread for the latest main interaction.
  const lastMainInteraction = lastMainRequest
    ? new DynamicInteraction(lastMainRequest)
    : null;
  const conversationMessages = lastMainInteraction
    ? lastMainInteraction.mapToUiMessages(
        lastMainRequest?.dualLlmAnalyses ?? [],
      )
    : [];
  const conversationChatErrors = lastMainRequest?.chatErrors ?? [];

  // The session's own numbers, as one wrapping row under the header. Labels
  // drop the "Total" every one of them used to carry: the page is a single
  // session, so there is nothing partial for a total to be distinguished from.
  const facts: DetailFact[] = [
    {
      label: "Requests",
      value: (
        <span className="font-mono tabular-nums">
          {totalRequests.toLocaleString()}
        </span>
      ),
    },
    {
      label: "Tokens",
      value: (
        <div className="space-y-0.5">
          <div className="font-mono tabular-nums">
            {totalInputTokens.toLocaleString()} in /{" "}
            {totalOutputTokens.toLocaleString()} out
          </div>
          {(totalCacheReadTokens > 0 || totalCacheWriteTokens > 0) && (
            <div className={cn(typeRole({ role: "meta" }), "font-mono")}>
              {totalCacheReadTokens.toLocaleString()} cache read /{" "}
              {totalCacheWriteTokens.toLocaleString()} cache write
            </div>
          )}
        </div>
      ),
    },
    {
      label: "Cost",
      value:
        totalCost && totalBaselineCost ? (
          <TooltipProvider>
            <BilledCost
              cost={totalCost}
              billedCost={totalBilledCost}
              subscriptionCost={totalSubscriptionCost}
              baselineCost={totalBaselineCost}
              toonCostSavings={totalToonCostSavings}
              format="percent"
              tooltip="hover"
              variant="session"
            />
          </TooltipProvider>
        ) : (
          <span className="font-mono tabular-nums">-</span>
        ),
    },
    ...(models.length > 0
      ? [
          {
            label: models.length === 1 ? "Model" : "Models",
            value: (
              <div className="flex flex-wrap gap-1">
                {models.map((model) => (
                  <Badge key={model} variant="secondary" className="text-xs">
                    {model}
                  </Badge>
                ))}
              </div>
            ),
          },
        ]
      : []),
    ...(firstRequest
      ? [
          {
            label: "First request",
            value: (
              <span className="font-mono tabular-nums">
                {formatDate({ date: firstRequest })}
              </span>
            ),
          },
        ]
      : []),
    ...(lastRequest
      ? [
          {
            label: "Last request",
            value: (
              <span className="font-mono tabular-nums">
                {formatDate({ date: lastRequest })}
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <PageLayout
      title={<span className="line-clamp-2">{sessionTitle || "Session"}</span>}
      documentTitle={sessionTitle || "Session"}
      backLink={<BackLink href="/llm/logs">Back to Sessions</BackLink>}
      // Who and what this session was, beside the title rather than repeated
      // as a second heading over a card below it.
      description={
        <div className="flex flex-wrap items-center gap-2">
          {clientSource && <ClientSourceBadge client={clientSource} />}
          <SourceBadge source={sessionData?.source} />
          {profileName && (
            <Badge variant="secondary" className="text-xs">
              <Layers className="h-3 w-3 mr-1" />
              {profileName}
            </Badge>
          )}
          {userNames.map((userName) => (
            <Badge key={userName} variant="outline" className="text-xs">
              <User className="h-3 w-3 mr-1" />
              <span>{userName}</span>
            </Badge>
          ))}
          <UnattributedUserBadge reason={sessionData?.unattributedReason} />
          <VirtualKeyBadge virtualKeys={sessionData?.virtualKeys} />
        </div>
      }
      actionButton={
        <Button
          variant="outline"
          size="sm"
          onClick={() => exportSession.mutate({ sessionId })}
          disabled={exportSession.isPending || totalRequests === 0}
        >
          {exportSession.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          <span>Export JSON</span>
        </Button>
      }
    >
      <div className="space-y-6">
        {/* Reads as a continuation of the header band above it, which is where
            these numbers belong: they describe the session, not a section of
            the page. The hairline separates them from the content proper. */}
        <DetailFacts facts={facts} className="border-b pb-6" />

        {/* Latest Conversation */}
        {lastMainRequest && conversationMessages.length > 0 && (
          <div>
            <h2 className="text-xl font-semibold mb-4">Latest Conversation</h2>
            <div className="border border-border rounded-lg bg-background overflow-hidden">
              <div className="max-h-[600px] overflow-y-auto">
                <MessageThread
                  messages={conversationMessages}
                  chatErrors={conversationChatErrors}
                  conversationId={lastMainRequest.sessionId ?? undefined}
                  containerClassName="h-auto"
                  hideDivider
                  profileId={lastMainRequest.profileId ?? undefined}
                  agentName={profileName ?? undefined}
                  selectedModel={lastMainInteraction?.modelName}
                  unsafeContextBoundary={lastMainRequest.unsafeContextBoundary}
                />
              </div>
            </div>
          </div>
        )}

        {/* Interactions Table */}
        {interactionsLoading ? (
          <LoadingState label="Loading session logs…" />
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <Table className="table-fixed w-full min-w-[700px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">Time</TableHead>
                  <TableHead className="w-[115px]">Agent</TableHead>
                  <TableHead className="w-[140px]">Model</TableHead>
                  <TableHead className="w-[140px]">Cost</TableHead>
                  <TableHead className="w-[30%]">User Message</TableHead>
                  <TableHead className="w-[120px]">Tools</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {interactions.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center text-muted-foreground"
                    >
                      No interactions found for this session
                    </TableCell>
                  </TableRow>
                ) : (
                  interactions.map((interaction) => {
                    const dynamicInteraction = new DynamicInteraction(
                      interaction,
                    );
                    const userMessage = dynamicInteraction.getLastUserMessage();
                    const toolsUsed = dynamicInteraction.getToolNamesUsed();
                    const requestType =
                      "requestType" in interaction
                        ? (interaction.requestType ?? "main")
                        : "main";
                    const externalAgentIdLabel =
                      "externalAgentIdLabel" in interaction
                        ? interaction.externalAgentIdLabel
                        : undefined;
                    // Show prompt name if available, fall back to raw externalAgentId, then Main/Subagent
                    const typeLabel =
                      externalAgentIdLabel ||
                      interaction.externalAgentId ||
                      (requestType === "main" ? "Main" : "Subagent");

                    return (
                      <TableRow
                        key={interaction.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() =>
                          router.push(`/llm/logs/${interaction.id}`)
                        }
                      >
                        <TableCell className="font-mono text-xs">
                          {formatDate({ date: dynamicInteraction.createdAt })}
                        </TableCell>
                        <TableCell className="overflow-hidden">
                          <Badge
                            variant="outline"
                            className="text-xs max-w-full inline-flex truncate"
                          >
                            {externalAgentIdLabel && (
                              <Bot className="h-3 w-3 mr-1 shrink-0" />
                            )}
                            <span className="truncate">{typeLabel}</span>
                          </Badge>
                        </TableCell>
                        <TableCell className="overflow-hidden">
                          <div className="flex flex-wrap gap-1">
                            <Badge
                              variant="secondary"
                              className="text-xs max-w-full inline-flex truncate"
                            >
                              {dynamicInteraction.modelName}
                            </Badge>
                            {dynamicInteraction.hasErrorResponse() && (
                              <Badge variant="destructive" className="text-xs">
                                Error
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          <TooltipProvider>
                            <BilledCost
                              cost={interaction.cost || "0"}
                              billingMode={interaction.billingMode}
                              baselineCost={
                                interaction.baselineCost ||
                                interaction.cost ||
                                "0"
                              }
                              toonCostSavings={interaction.toonCostSavings}
                              toonTokensBefore={interaction.toonTokensBefore}
                              toonTokensAfter={interaction.toonTokensAfter}
                              toonSkipReason={interaction.toonSkipReason}
                              format="percent"
                              tooltip="hover"
                              variant="interaction"
                              baselineModel={interaction.baselineModel}
                              actualModel={interaction.model}
                            />
                          </TooltipProvider>
                        </TableCell>
                        <TableCell className="text-xs overflow-hidden">
                          <TruncatedText
                            message={userMessage}
                            maxLength={80}
                            showTooltip={false}
                          />
                        </TableCell>
                        <TableCell className="text-xs overflow-hidden">
                          {toolsUsed.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {toolsUsed.slice(0, 2).map((tool) => (
                                <Badge
                                  key={tool}
                                  variant="outline"
                                  className="text-xs max-w-[65px] inline-block truncate"
                                >
                                  {tool}
                                </Badge>
                              ))}
                              {toolsUsed.length > 2 && (
                                <Badge variant="outline" className="text-xs">
                                  +{toolsUsed.length - 2}
                                </Badge>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
            {paginationMeta && paginationMeta.total > 0 && (
              <div className="px-2 py-4">
                <TablePagination
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  total={paginationMeta.total}
                  onPaginationChange={setPagination}
                  leftContent={
                    <>
                      Showing {offset + 1} to{" "}
                      {Math.min(offset + pageSize, paginationMeta.total)} of{" "}
                      {paginationMeta.total} requests
                    </>
                  }
                />
              </div>
            )}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
