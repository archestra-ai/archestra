"use client";

import { useRouter } from "next/navigation";
import { useCreateScheduleTriggerRunConversation } from "@/lib/schedule-trigger.query";

/**
 * Open a scheduled run that has no conversation yet: lazily create one, then
 * navigate to its chat carrying the schedule context. Shared by the runs list
 * and the project Schedules section so the create-then-navigate lives in one
 * place (a run that already has a conversation is a plain `<Link>` instead).
 */
export function useResolveRunChat() {
  const router = useRouter();
  const ensureConversation = useCreateScheduleTriggerRunConversation();

  return {
    isResolving: ensureConversation.isPending,
    resolve: (triggerId: string, runId: string) =>
      ensureConversation.mutate(
        { triggerId, runId },
        {
          onSuccess: (conversation) =>
            router.push(
              `/chat/${conversation.id}?scheduleTriggerId=${triggerId}&scheduleRunId=${runId}`,
            ),
        },
      ),
  };
}
