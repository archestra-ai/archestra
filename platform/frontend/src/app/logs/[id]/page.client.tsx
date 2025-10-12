"use client";

import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import ChatBotDemo from "@/components/chatbot-demo";
import Divider from "@/components/divider";
import { InteractionSummary } from "@/components/interaction-summary";
import { LoadingSpinner } from "@/components/loading";
import type {
  GetAgentsResponses,
  GetInteractionResponse,
} from "@/lib/clients/api";
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

  if (!interaction) {
    return "Interaction not found";
  }

  const _refusedCount = toolsRefusedCountForInteraction(interaction);

  // Map request messages
  const requestMessages = interaction.request.messages.map(
    mapInteractionToUiMessage,
  );

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
