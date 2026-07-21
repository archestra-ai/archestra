"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LoadingSpinner } from "@/components/loading";
import { useSettingsTabs } from "./settings-tabs";

// Landing page: settings has no content of its own, so forward to the first
// tab the user is allowed to see. The tab list is permission-gated and empty
// until permissions load.
export default function SettingsIndexPage() {
  const router = useRouter();
  const tabs = useSettingsTabs();
  const firstTab = tabs[0]?.href;

  useEffect(() => {
    if (firstTab) {
      router.replace(firstTab);
    }
  }, [firstTab, router]);

  return <LoadingSpinner className="my-8" />;
}
