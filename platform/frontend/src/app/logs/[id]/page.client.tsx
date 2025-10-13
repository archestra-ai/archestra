"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import ChatBotDemo, {
  type DualLlmPart,
  type PartialUIMessage,
} from "@/components/chatbot-demo";
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
import {
  getLastToolCallId,
  isLastMessageToolCall,
  mapInteractionToUiMessage,
  toolNamesRefusedForInteraction,
  toolNamesUsedForInteraction,
} from "@/lib/interaction.utils";
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
  const { data: interaction } = useInteraction({
    interactionId: id,
    initialData: initialData?.interaction,
  });

  const { data: allDualLlmResults = [] } = useDualLlmResultsByInteraction({
    interactionId: id,
  });

  if (!interaction) {
    return (
      <div className="text-muted-foreground p-8">Interaction not found</div>
    );
  }

  const agent = initialData?.agents.find((a) => a.id === interaction.agentId);
  const toolsUsed = toolNamesUsedForInteraction(interaction);
  const toolsBlocked = toolNamesRefusedForInteraction(interaction);
  const isDualLlmRelevant = isLastMessageToolCall(interaction);
  const lastToolCallId = getLastToolCallId(interaction);
  const dualLlmResult = allDualLlmResults.find(
    (r) => r.toolCallId === lastToolCallId,
  );

  // Map request messages, combining tool calls with their results and dual LLM analysis
  const requestMessages: PartialUIMessage[] = [];
  const messages = interaction.request.messages;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Skip tool messages - they'll be merged with their assistant message
    if (msg.role === "tool") {
      continue;
    }

    const uiMessage = mapInteractionToUiMessage(msg);

    // If this is an assistant message with tool_calls, look ahead for tool results
    if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
      const toolCallParts: PartialUIMessage["parts"] = [...uiMessage.parts];

      // For each tool call, find its corresponding tool result
      for (const toolCall of msg.tool_calls) {
        // Find the tool result message
        const toolResultMsg = messages
          .slice(i + 1)
          .find((m) => m.role === "tool" && m.tool_call_id === toolCall.id);

        if (toolResultMsg) {
          // Map the tool result to a UI part
          const toolResultUiMsg = mapInteractionToUiMessage(toolResultMsg);
          toolCallParts.push(...toolResultUiMsg.parts);

          // Check if there's a dual LLM result for this tool call
          const dualLlmResultForTool = allDualLlmResults.find(
            (result) => result.toolCallId === toolCall.id,
          );

          if (dualLlmResultForTool) {
            const dualLlmPart: DualLlmPart = {
              type: "dual-llm-analysis",
              toolCallId: dualLlmResultForTool.toolCallId,
              safeResult: dualLlmResultForTool.result,
              conversations: Array.isArray(dualLlmResultForTool.conversations)
                ? (dualLlmResultForTool.conversations as DualLlmPart["conversations"])
                : [],
            };
            toolCallParts.push(dualLlmPart);
          }
        }
      }

      requestMessages.push({
        ...uiMessage,
        parts: toolCallParts,
      });
    } else {
      requestMessages.push(uiMessage);
    }
  }

  // Add response message if available
  const responseMessage = interaction.response?.choices?.[0]?.message;
  if (responseMessage) {
    requestMessages.push(mapInteractionToUiMessage(responseMessage));
  }

  return (
    <>
      {/* Header */}
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
        {/* Metadata Section */}
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
                <div className="text-sm text-muted-foreground mb-2">Model</div>
                <div className="font-medium">{interaction.request.model}</div>
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

        {/* Conversation Section */}
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

        {/* Raw Data Section */}
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
                    {JSON.stringify(interaction.request, null, 2)}
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
                    {JSON.stringify(interaction.response, null, 2)}
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
