"use client";

import type { archestraApiTypes } from "@shared";
import { ArrowLeft, Database, Layers } from "lucide-react";
import Link from "next/link";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { JsonCodeBlock } from "@/components/json-code-block";
import { LoadingSpinner } from "@/components/loading";
import MessageThread from "@/components/message-thread";
import { MetadataCard, MetadataItem } from "@/components/metadata-card";
import { Savings } from "@/components/savings";
import { SourceBadge } from "@/components/source-badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useInteraction } from "@/lib/interaction.query";
import {
  calculateCostSavings,
  DynamicInteraction,
} from "@/lib/interaction.utils";
import { formatDate } from "@/lib/utils";

export function ChatPage({
  initialData,
  id,
}: {
  initialData?: {
    interaction: archestraApiTypes.GetInteractionResponses["200"] | undefined;
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
  id: string;
}) {
  return (
    <div className="w-full h-full overflow-y-auto">
      <ErrorBoundary>
        <LogDetail initialData={initialData} id={id} />
      </ErrorBoundary>
    </div>
  );
}

function LogDetail({
  initialData,
  id,
}: {
  initialData?: {
    interaction: archestraApiTypes.GetInteractionResponses["200"] | undefined;
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
  id: string;
}) {
  const { data: dynamicInteraction, isPending } = useInteraction({
    interactionId: id,
    initialData: initialData?.interaction,
  });

  if (isPending) {
    return <LoadingSpinner />;
  }

  if (!dynamicInteraction) {
    return (
      <div className="text-muted-foreground p-8">Interaction not found</div>
    );
  }

  const interaction = new DynamicInteraction(dynamicInteraction);
  const agent = initialData?.agents?.find(
    (a) => a.id === interaction.profileId,
  );
  const toolsUsed = interaction.getToolNamesUsed();
  const toolsBlocked = interaction.getToolNamesRefused();
  const isDualLlmRelevant = interaction.isLastMessageToolCall();
  const lastToolCallId = interaction.getLastToolCallId();
  const allDualLlmAnalyses = dynamicInteraction.dualLlmAnalyses ?? [];
  const dualLlmResult = allDualLlmAnalyses.find(
    (r) => r.toolCallId === lastToolCallId,
  );

  const requestMessages = new DynamicInteraction(
    dynamicInteraction,
  ).mapToUiMessages(allDualLlmAnalyses);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          {dynamicInteraction.sessionId ? (
            <Link
              href={`/llm/logs/session/${encodeURIComponent(dynamicInteraction.sessionId)}`}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Session
            </Link>
          ) : (
            <Link href="/llm/logs">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Sessions
            </Link>
          )}
        </Button>
      </div>

      <div>
        <div className="mb-8">
          <MetadataCard
            title="Metadata"
            badges={
              <>
                <SourceBadge source={dynamicInteraction.source} />
                <Badge variant="secondary" className="text-xs">
                  {dynamicInteraction.source?.startsWith("knowledge:") ? (
                    <>
                      <Database className="h-3 w-3 mr-1" />
                      Knowledge Base
                    </>
                  ) : (
                    <>
                      <Layers className="h-3 w-3 mr-1" />
                      {agent?.name ??
                        (interaction.profileId === null
                          ? "Deleted LLM Proxy"
                          : "Unknown")}
                    </>
                  )}
                </Badge>
              </>
            }
          >
            <MetadataItem label="Tokens">
              <div className="font-mono">
                {(dynamicInteraction.inputTokens ?? 0).toLocaleString()} in /{" "}
                {(dynamicInteraction.outputTokens ?? 0).toLocaleString()} out
              </div>
            </MetadataItem>
            <MetadataItem label="Cost">
              <div className="font-mono">
                {dynamicInteraction.cost ? (
                  (() => {
                    const savings = calculateCostSavings(dynamicInteraction);
                    const effectiveCost = dynamicInteraction.cost;
                    const effectiveBaselineCost =
                      dynamicInteraction.baselineCost ||
                      dynamicInteraction.cost;
                    return (
                      <TooltipProvider>
                        <Savings
                          cost={effectiveCost}
                          baselineCost={effectiveBaselineCost}
                          toonCostSavings={dynamicInteraction.toonCostSavings}
                          toonTokensSaved={savings.toonTokensSaved}
                          toonSkipReason={dynamicInteraction.toonSkipReason}
                          format="percent"
                          tooltip="always"
                          variant="interaction"
                          baselineModel={dynamicInteraction.baselineModel}
                          actualModel={dynamicInteraction.model}
                        />
                      </TooltipProvider>
                    );
                  })()
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
            </MetadataItem>
            <MetadataItem label="Model">
              <Badge variant="secondary" className="text-xs">
                {interaction.provider} ({interaction.modelName})
              </Badge>
            </MetadataItem>
            <MetadataItem label="Timestamp">
              <div className="font-mono text-xs">
                {formatDate({ date: interaction.createdAt })}
              </div>
            </MetadataItem>
            {dynamicInteraction.externalAgentId && (
              <MetadataItem label="External Agent">
                <div className="font-mono text-xs">
                  {dynamicInteraction.externalAgentId}
                </div>
              </MetadataItem>
            )}
            {dynamicInteraction.executionId && (
              <MetadataItem label="Execution ID">
                <div className="font-mono text-xs">
                  {dynamicInteraction.executionId}
                </div>
              </MetadataItem>
            )}
            <MetadataItem label="Tools Used">
              {toolsUsed.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {toolsUsed.map((toolName) => (
                    <Badge
                      key={toolName}
                      variant="secondary"
                      className="text-xs"
                    >
                      {toolName}
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground">None</div>
              )}
            </MetadataItem>
            {toolsBlocked.length > 0 && (
              <MetadataItem label="Tools Blocked">
                <div className="flex flex-wrap gap-1">
                  {toolsBlocked.map((toolName) => (
                    <Badge
                      key={toolName}
                      variant="destructive"
                      className="text-xs"
                    >
                      {toolName}
                    </Badge>
                  ))}
                </div>
              </MetadataItem>
            )}
            {isDualLlmRelevant && (
              <MetadataItem label="Dual LLM Analysis">
                {dualLlmResult ? (
                  <Badge className="bg-green-600">Analyzed</Badge>
                ) : (
                  <div className="text-muted-foreground">Not analyzed</div>
                )}
              </MetadataItem>
            )}
          </MetadataCard>
        </div>

        {requestMessages.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-4">Conversation</h2>
            <div className="border border-border rounded-lg bg-background overflow-hidden">
              <MessageThread
                messages={requestMessages}
                containerClassName="h-auto"
                hideDivider={true}
                profileId={agent?.id}
              />
            </div>
          </div>
        )}

        <div>
          <h2 className="text-xl font-semibold mb-4">Raw Data</h2>
          <Accordion type="single" collapsible defaultValue="response">
            <AccordionItem value="request" className="border rounded-lg mb-2">
              <AccordionTrigger className="px-6 py-4 hover:no-underline">
                <span className="text-base font-semibold">
                  Raw Request (Original)
                </span>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-4">
                <JsonCodeBlock value={dynamicInteraction.request} />
              </AccordionContent>
            </AccordionItem>

            {dynamicInteraction.processedRequest && (
              <AccordionItem
                value="processedRequest"
                className="border rounded-lg mb-2"
              >
                <AccordionTrigger className="px-6 py-4 hover:no-underline">
                  <span className="text-base font-semibold">
                    Processed Request (Sent to LLM)
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-6 pb-4">
                  <JsonCodeBlock value={dynamicInteraction.processedRequest} />
                  <p className="text-xs text-muted-foreground mt-2">
                    This shows the request after processing (e.g., TOON
                    conversion, trusted data filtering, etc.)
                  </p>
                </AccordionContent>
              </AccordionItem>
            )}

            <AccordionItem
              value="response"
              className="border rounded-lg !border-b"
            >
              <AccordionTrigger className="px-6 py-4 hover:no-underline">
                <span className="text-base font-semibold">Raw Response</span>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-4">
                <JsonCodeBlock value={dynamicInteraction.response} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </div>
    </div>
  );
}
