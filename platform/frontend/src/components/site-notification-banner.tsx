"use client";

import { usePublicConfig } from "@/lib/config/config.query";
import { Info } from "lucide-react";

export function SiteNotificationBanner() {
  const { data: config } = usePublicConfig();

  if (!config?.siteNotification) {
    return null;
  }

  return (
    <div className="bg-blue-600 dark:bg-blue-900 text-white px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium z-[100]">
      <Info className="w-4 h-4" />
      <span>{config.siteNotification}</span>
    </div>
  );
}
