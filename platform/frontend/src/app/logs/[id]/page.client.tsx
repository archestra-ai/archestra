"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import ChatBotDemo from "@/components/chatbot-demo";
import { LoadingSpinner } from "@/components/loading";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  GetAgentsResponses,
  GetInteractionResponse,
} from "@/lib/clients/api";
import { useDualLlmResultsByInteraction } from "@/lib/dual-llm-result.query";
import { useInteraction } from "@/lib/interaction.query";
import { DynamicInteraction } from "@/lib/interaction.utils";
import { formatDate } from "@/lib/utils";

export function ChatPage({
  initialData,
  id,
}: {
  initialData?: {
    interaction: GetInteractionResponse | undefined;
    agents: GetAgentsResponses["200"];
  };
  id: string;
}) {
  return (
    <div className="w-full h-full overflow-y-auto">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <LogDetail initialData={initialData} id={id} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function LogDetail({
  initialData,
  id,
}: {
  initialData?: {
    interaction: GetInteractionResponse | undefined;
    agents: GetAgentsResponses["200"];
  };
  id: string;
}) {
  const { data: dynamicInteraction } = useInteraction({
    interactionId: id,
    initialData: initialData?.interaction,
  });

  const { data: allDualLlmResults = [] } = useDualLlmResultsByInteraction({
    interactionId: id,
  });

  if (!dynamicInteraction) {
    return (
      <div className="text-muted-foreground p-8">Interaction not found</div>
    );
  }

  const interaction = new DynamicInteraction(dynamicInteraction);
  const agent = initialData?.agents.find((a) => a.id === interaction.agentId);
  const toolsUsed = interaction.getToolNamesUsed();
  const toolsBlocked = interaction.getToolNamesRefused();
  const isDualLlmRelevant = interaction.isLastMessageToolCall();
  const lastToolCallId = interaction.getLastToolCallId();
  const dualLlmResult = allDualLlmResults.find(
    (r) => r.toolCallId === lastToolCallId,
  );

  const requestMessages = new DynamicInteraction(
    dynamicInteraction,
  ).mapToUiMessages(allDualLlmResults);

  return (
    <>
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-8">
          <div className="flex items-center gap-4 mb-2">
            <Button variant="ghost" size="icon" asChild>
              <Link href="/logs">
                <ArrowLeft className="h-5 w-5" />
              </Link>
            </Button>
            <h1 className="text-2xl font-semibold tracking-tight">
              Log Details
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-14">
            {formatDate({ date: interaction.createdAt })}
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 md:px-8 py-8 space-y-8">
        <div>
          <h2 className="text-xl font-semibold mb-4">Metadata</h2>
          <div className="border border-border rounded-lg p-6 bg-card">
            <div className="grid grid-cols-2 gap-x-12 gap-y-6">
              <div>
                <div className="text-sm text-muted-foreground mb-2">
                  Agent Name
                </div>
                <div className="font-medium">{agent?.name ?? "Unknown"}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-2">
                  Provider + Model
                </div>
                <div className="font-medium">
                  {interaction.provider} ({interaction.modelName})
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-2">
                  Tools Used
                </div>
                {toolsUsed.length > 0 ? (
                  <div className="space-y-1">
                    {toolsUsed.map((toolName) => (
                      <div key={toolName} className="font-mono text-sm">
                        {toolName}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-muted-foreground">None</div>
                )}
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-2">
                  Tools Blocked
                </div>
                {toolsBlocked.length > 0 ? (
                  <div className="space-y-1">
                    {toolsBlocked.map((toolName) => (
                      <div key={toolName} className="font-mono text-sm">
                        {toolName}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-muted-foreground">None</div>
                )}
              </div>
              {isDualLlmRelevant && (
                <div>
                  <div className="text-sm text-muted-foreground mb-2">
                    Dual LLM Analysis
                  </div>
                  {dualLlmResult ? (
                    <Badge className="bg-green-600">Analyzed</Badge>
                  ) : (
                    <div className="text-muted-foreground">Not analyzed</div>
                  )}
                </div>
              )}
              <div>
                <div className="text-sm text-muted-foreground mb-2">
                  Timestamp
                </div>
                <div className="font-medium">
                  {formatDate({ date: interaction.createdAt })}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div>
          <h2 className="text-xl font-semibold mb-4">Conversation</h2>
          <div className="border border-border rounded-lg bg-card overflow-hidden">
            <ChatBotDemo
              messages={requestMessages}
              containerClassName="h-auto"
              hideDivider={true}
            />
          </div>
        </div>

        <div>
          <h2 className="text-xl font-semibold mb-4">Raw Data</h2>
          <Accordion type="single" collapsible defaultValue="response">
            <AccordionItem value="request" className="border rounded-lg mb-2">
              <AccordionTrigger className="px-6 py-4 hover:no-underline">
                <span className="text-base font-semibold">Raw Request</span>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-4">
                <div className="bg-muted rounded-lg p-4 overflow-x-auto">
                  <pre className="text-xs">
                    {JSON.stringify(dynamicInteraction.request, null, 2)}
                  </pre>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="response" className="border rounded-lg">
              <AccordionTrigger className="px-6 py-4 hover:no-underline">
                <span className="text-base font-semibold">Raw Response</span>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-4">
                <div className="bg-muted rounded-lg p-4 overflow-x-auto">
                  <pre className="text-xs">
                    {JSON.stringify(dynamicInteraction.response, null, 2)}
                  </pre>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </div>
    </>
  );
}
