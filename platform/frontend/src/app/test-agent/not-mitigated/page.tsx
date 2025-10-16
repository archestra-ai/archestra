"use client";

import { ALLOWED_DEMO_INTERACTION_ID } from "@shared";
import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import ChatBotDemo from "@/components/chatbot-demo";
import Divider from "@/components/divider";
import { InteractionSummary } from "@/components/interaction-summary";
import { LoadingSpinner } from "@/components/loading";
import { useAgents } from "@/lib/agent.query";
import { useInteraction } from "@/lib/interaction.query";
import { DynamicInteraction } from "@/lib/interaction.utils";

export const dynamic = "force-dynamic";

export default function NotMitigatedPage() {
  return (
    <div className="container mx-auto">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <NotMitigated />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function NotMitigated() {
  const { data: dynamicInteraction } = useInteraction({
    interactionId: ALLOWED_DEMO_INTERACTION_ID,
    refetchInterval: null,
  });
  const { data: agents } = useAgents();

  if (!dynamicInteraction) {
    return null;
  }

  const requestMessages = new DynamicInteraction(
    dynamicInteraction,
  ).mapToUiMessages();

  return (
    <>
      <Divider />
      <div className="px-2">
        <ChatBotDemo
          messages={requestMessages}
          topPart={
            <InteractionSummary
              interaction={dynamicInteraction}
              agent={agents?.find(
                (agent) => agent.id === dynamicInteraction.agentId,
              )}
            />
          }
        />
      </div>
    </>
  );
}
