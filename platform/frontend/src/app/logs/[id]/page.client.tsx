"use client";

import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import ChatBotDemo, {
  type DualLlmPart,
  type PartialUIMessage,
} from "@/components/chatbot-demo";
import Divider from "@/components/divider";
import { InteractionSummary } from "@/components/interaction-summary";
import { LoadingSpinner } from "@/components/loading";
import type {
  GetAgentsResponses,
  GetInteractionResponse,
} from "@/lib/clients/api";
import { useDualLlmResultsByInteraction } from "@/lib/dual-llm-result.query";
import { useInteraction } from "@/lib/interaction.query";
import {
  mapInteractionToUiMessage,
  toolsRefusedCountForInteraction,
} from "@/lib/interaction.utils";

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
    <div className="container mx-auto">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <Chat initialData={initialData} id={id} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

export function Chat({
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

  // Fetch all dual LLM results for this interaction
  const { data: allDualLlmResults = [] } = useDualLlmResultsByInteraction({
    interactionId: id,
  });

  if (!interaction) {
    return "Interaction not found";
  }

  const _refusedCount = toolsRefusedCountForInteraction(interaction);

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
          const dualLlmResult = allDualLlmResults.find(
            (result) => result.toolCallId === toolCall.id,
          );

          if (dualLlmResult) {
            const dualLlmPart: DualLlmPart = {
              type: "dual-llm-analysis",
              toolCallId: dualLlmResult.toolCallId,
              safeResult: dualLlmResult.result,
              conversations: Array.isArray(dualLlmResult.conversations)
                ? (dualLlmResult.conversations as DualLlmPart["conversations"])
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
      <Divider />
      <div className="px-2">
        <ChatBotDemo
          messages={requestMessages}
          topPart={
            <InteractionSummary
              interaction={interaction}
              agent={initialData?.agents.find(
                (agent) => agent.id === interaction.agentId,
              )}
            />
          }
        />
      </div>
    </>
  );
}
