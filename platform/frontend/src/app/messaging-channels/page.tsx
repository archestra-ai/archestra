"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTriggerStatuses } from "./_components/use-trigger-statuses";

export default function AgentTriggersPage() {
  const router = useRouter();
  const { isLoading, firstActiveHref } = useTriggerStatuses();

  useEffect(() => {
    if (isLoading) return;
    router.replace(firstActiveHref);
  }, [isLoading, firstActiveHref, router]);

  return null;
}
