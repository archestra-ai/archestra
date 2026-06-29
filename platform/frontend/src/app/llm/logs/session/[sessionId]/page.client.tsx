"use client";

import { DynamicInteraction, getSessionClientLabel } from "@archestra/shared";
import { ArrowLeft, Bot, Layers, Loader2, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use } from "react";
import MessageThread from "@/components/message-thread";
import { MetadataCard, MetadataItem } from "@/components/metadata-card";
import { Savings } from "@/components/savings";
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
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  useInteractionSessions,
  useInteractions,
} from "@/lib/interactions/interaction.query";
import { formatDate } from "@/lib/utils";

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
  const totalBaselineCost = sessionData?.totalBaselineCost;
  const totalToonCostSavings = sessionData?.totalToonCostSavings;

  // Session metadata from API
  // Badge label for the Claude clients (Code and Desktop); null for other sources.
  const claudeSourceLabel = getSessionClientLabel(sessionData?.sessionSource);
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/llm/logs">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Sessions
          </Link>
        </Button>
      </div>

      {/* Session Summary */}
      <MetadataCard
        title={sessionTitle || "Session"}
        badges={
          <>
            {claudeSourceLabel && (
              <Badge
                variant="secondary"
                className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300"
              >
                {claudeSourceLabel}
              </Badge>
            )}
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
                {userName}
              </Badge>
            ))}
          </>
        }
      >
        <MetadataItem label="Total Requests">
          <div className="font-semibold">{totalRequests}</div>
        </MetadataItem>
        <MetadataItem label="Total Tokens">
          <div className="font-mono">
            {totalInputTokens.toLocaleString()} in /{" "}
            {totalOutputTokens.toLocaleString()} out
          </div>
          {(totalCacheReadTokens > 0 || totalCacheWriteTokens > 0) && (
            <div className="font-mono text-xs text-muted-foreground">
              {totalCacheReadTokens.toLocaleString()} cache read /{" "}
              {totalCacheWriteTokens.toLocaleString()} cache write
            </div>
          )}
        </MetadataItem>
        <MetadataItem label="Total Cost">
          <div className="font-mono">
            {totalCost && totalBaselineCost ? (
              <TooltipProvider>
                <Savings
                  cost={totalCost}
                  baselineCost={totalBaselineCost}
                  toonCostSavings={totalToonCostSavings}
                  format="percent"
                  tooltip="hover"
                  variant="session"
                />
              </TooltipProvider>
            ) : (
              "-"
            )}
          </div>
        </MetadataItem>
        <MetadataItem label="Models">
          <div className="flex flex-wrap gap-1">
            {models.map((model) => (
              <Badge key={model} variant="secondary" className="text-xs">
                {model}
              </Badge>
            ))}
          </div>
        </MetadataItem>
        {firstRequest && (
          <MetadataItem label="First Request">
            <div className="font-mono text-xs">
              {formatDate({ date: firstRequest })}
            </div>
          </MetadataItem>
        )}
        {lastRequest && (
          <MetadataItem label="Last Request">
            <div className="font-mono text-xs">
              {formatDate({ date: lastRequest })}
            </div>
          </MetadataItem>
        )}
      </MetadataCard>

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
            {interactionsLoading ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground"
                >
                  <div className="flex items-center justify-center gap-2 py-6">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading session logs...
                  </div>
                </TableCell>
              </TableRow>
            ) : interactions.length === 0 ? (
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
                const dynamicInteraction = new DynamicInteraction(interaction);
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
                    onClick={() => router.push(`/llm/logs/${interaction.id}`)}
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
                      <Badge
                        variant="secondary"
                        className="text-xs max-w-full inline-flex truncate"
                      >
                        {dynamicInteraction.modelName}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <TooltipProvider>
                        <Savings
                          cost={interaction.cost || "0"}
                          baselineCost={
                            interaction.baselineCost || interaction.cost || "0"
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
    </div>
  );
}
