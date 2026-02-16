"use client";

import { ArrowLeft, Bot, ExternalLink, Layers, User } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { use, useCallback } from "react";
import { Savings } from "@/components/savings";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useInteractionSessions,
  useInteractions,
} from "@/lib/interaction.query";
import {
  calculateCostSavings,
  DynamicInteraction,
} from "@/lib/interaction.utils";
import { DEFAULT_TABLE_LIMIT, formatDate } from "@/lib/utils";

export default function SessionDetailPage({
  paramsPromise,
}: {
  paramsPromise: Promise<{ sessionId: string }>;
}) {
  const params = use(paramsPromise);
  const router = useRouter();
  const searchParams = useSearchParams();

  const pageFromUrl = searchParams.get("page");
  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = DEFAULT_TABLE_LIMIT;

  const { data: interactionsResponse } = useInteractions({
    sessionId: params.sessionId,
    limit: pageSize,
    offset: pageIndex * pageSize,
    sortBy: "createdAt",
    sortDirection: "desc",
  });

  // Fetch session metadata (profile name, user names, etc.)
  const { data: sessionResponse } = useInteractionSessions({
    sessionId: params.sessionId,
    limit: 1,
  });

  const interactions = interactionsResponse?.data ?? [];
  const paginationMeta = interactionsResponse?.pagination;
  const sessionData = sessionResponse?.data?.[0];

  const handlePageChange = useCallback(
    (newPage: number) => {
      const newParams = new URLSearchParams(searchParams.toString());
      if (newPage === 0) {
        newParams.delete("page");
      } else {
        newParams.set("page", String(newPage + 1));
      }
      router.push(
        `/logs/llm-proxy/session/${params.sessionId}?${newParams.toString()}`,
        { scroll: false },
      );
    },
    [searchParams, router, params.sessionId],
  );

  // Use session data from API for accurate totals, fall back to page data
  const totalInputTokens =
    sessionData?.totalInputTokens ??
    interactions.reduce((sum, i) => sum + (i.inputTokens ?? 0), 0);
  const totalOutputTokens =
    sessionData?.totalOutputTokens ??
    interactions.reduce((sum, i) => sum + (i.outputTokens ?? 0), 0);
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
  const sessionSource = sessionData?.sessionSource;
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

  // Find the last main request (requestType === "main" or first in delegation chain)
  const lastMainRequest = interactions.find((interaction) => {
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/logs/llm-proxy">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Sessions
          </Link>
        </Button>
      </div>

      {/* Session Summary */}
      <div className="rounded-lg border p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0 flex-1">
            <h2 className="text-lg font-semibold truncate">
              {sessionTitle || "Session"}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {sessionSource === "claude_code" && (
                <Badge
                  variant="secondary"
                  className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300"
                >
                  Claude Code
                </Badge>
              )}
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
            </div>
          </div>
          {lastMainRequest && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/logs/${lastMainRequest.id}`}>
                <ExternalLink className="h-4 w-4 mr-2" />
                View
              </Link>
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground">Total Requests</div>
            <div className="font-semibold">{totalRequests}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Total Tokens</div>
            <div className="font-mono">
              {totalInputTokens.toLocaleString()} in /{" "}
              {totalOutputTokens.toLocaleString()} out
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Total Cost</div>
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
          </div>
          <div>
            <div className="text-muted-foreground">Models</div>
            <div className="flex flex-wrap gap-1">
              {models.map((model) => (
                <Badge key={model} variant="secondary" className="text-xs">
                  {model}
                </Badge>
              ))}
            </div>
          </div>
          {firstRequest && (
            <div>
              <div className="text-muted-foreground">First Request</div>
              <div className="font-mono text-xs">
                {formatDate({ date: firstRequest })}
              </div>
            </div>
          )}
          {lastRequest && (
            <div>
              <div className="text-muted-foreground">Last Request</div>
              <div className="font-mono text-xs">
                {formatDate({ date: lastRequest })}
              </div>
            </div>
          )}
        </div>
      </div>

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
                    onClick={() => router.push(`/logs/${interaction.id}`)}
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
                        className="text-xs max-w-full inline-block truncate"
                      >
                        {dynamicInteraction.modelName}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {(() => {
                        const savings = calculateCostSavings(interaction);
                        return (
                          <TooltipProvider>
                            <Savings
                              cost={interaction.cost || "0"}
                              baselineCost={
                                interaction.baselineCost ||
                                interaction.cost ||
                                "0"
                              }
                              toonCostSavings={interaction.toonCostSavings}
                              toonTokensSaved={savings.toonTokensSaved}
                              toonSkipReason={interaction.toonSkipReason}
                              format="percent"
                              tooltip="hover"
                              variant="interaction"
                              baselineModel={interaction.baselineModel}
                              actualModel={interaction.model}
                            />
                          </TooltipProvider>
                        );
                      })()}
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
        {paginationMeta && paginationMeta.total > pageSize && (
          <div className="flex items-center justify-between px-2 py-4">
            <div className="text-sm text-muted-foreground">
              Showing {pageIndex * pageSize + 1} to{" "}
              {Math.min((pageIndex + 1) * pageSize, paginationMeta.total)} of{" "}
              {paginationMeta.total} requests
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(pageIndex - 1)}
                disabled={pageIndex === 0}
              >
                Previous
              </Button>
              <span className="text-sm">
                Page {pageIndex + 1} of{" "}
                {Math.ceil(paginationMeta.total / pageSize)}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(pageIndex + 1)}
                disabled={
                  pageIndex >= Math.ceil(paginationMeta.total / pageSize) - 1
                }
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
