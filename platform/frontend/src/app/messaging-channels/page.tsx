"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTriggerStatuses } from "./_components/use-trigger-statuses";

export default function AgentTriggersPage() {
  const router = useRouter();
  const { isLoading, firstActiveHref } = useTriggerStatuses();

  useEffect(() => {
    if (isLoading) return;
    // Null means every channel is turned off. Staying here lets the layout
    // render its "no channels" state rather than bouncing onto a dead route.
    if (!firstActiveHref) return;
    router.replace(firstActiveHref);
  }, [isLoading, firstActiveHref, router]);

  return null;
}
