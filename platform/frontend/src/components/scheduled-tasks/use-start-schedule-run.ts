"use client";

import { useRouter } from "next/navigation";
import { runHref } from "@/app/projects/[id]/schedules/[triggerId]/run-row.utils";
import { useResolveRunChat } from "@/components/scheduled-tasks/use-resolve-run-chat";
import { useRunScheduleTriggerNow } from "@/lib/schedule-trigger.query";

/** Follow the newly created run, never whichever run happens to be latest. */
export function useStartScheduleRun(triggerId: string) {
  const router = useRouter();
  const create = useRunScheduleTriggerNow();
  const { resolve, isResolving } = useResolveRunChat();

  return {
    isPending: create.isPending || isResolving,
    start: () =>
      create.mutate(triggerId, {
        onSuccess: (created) => {
          if (!created) return;
          const href = runHref({ triggerId, run: created });
          if (href) router.push(href);
          else resolve(triggerId, created.id);
        },
      }),
  };
}
