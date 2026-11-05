"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTriggerStatuses } from "@/components/messaging-channels/use-trigger-statuses";

export default function MessagingChannelSettingsPage() {
  const router = useRouter();
  const { isLoading, firstProviderHref } = useTriggerStatuses();

  useEffect(() => {
    if (isLoading || !firstProviderHref) return;
    router.replace(firstProviderHref);
  }, [firstProviderHref, isLoading, router]);

  return null;
}
