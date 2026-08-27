"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTriggerStatuses } from "@/app/messaging-channels/_components/use-trigger-statuses";

export default function MessagingChannelSettingsPage() {
  const router = useRouter();
  const { isLoading, firstProviderHref } = useTriggerStatuses();

  useEffect(() => {
    if (isLoading || !firstProviderHref) return;
    router.replace(
      firstProviderHref.replace(
        "/messaging-channels",
        "/settings/messaging-channels",
      ),
    );
  }, [firstProviderHref, isLoading, router]);

  return null;
}
