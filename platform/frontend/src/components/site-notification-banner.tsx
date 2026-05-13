"use client";

import { Megaphone } from "lucide-react";
import { SiteNotificationMarkdown } from "./site-notification-markdown";

interface SiteNotificationBannerProps {
  markdown: string;
}

export function SiteNotificationBanner({
  markdown,
}: SiteNotificationBannerProps) {
  return (
    <div className="border-b border-border bg-muted/50 px-4 py-2 sm:px-6">
      <div className="flex items-start gap-3">
        <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <SiteNotificationMarkdown
          markdown={markdown}
          className="flex-1 text-foreground"
        />
      </div>
    </div>
  );
}
