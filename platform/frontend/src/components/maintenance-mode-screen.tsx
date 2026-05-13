"use client";

import { Wrench } from "lucide-react";
import { SiteNotificationMarkdown } from "./site-notification-markdown";

interface MaintenanceModeScreenProps {
  message: string | null;
}

const DEFAULT_MESSAGE = "Scheduled maintenance is currently in progress.";

export function MaintenanceModeScreen({ message }: MaintenanceModeScreenProps) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10">
      <div className="w-full max-w-2xl space-y-4">
        <div className="flex items-center gap-3">
          <Wrench className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">
            Scheduled maintenance
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          This deployment is temporarily unavailable while maintenance is in
          progress.
        </p>
        <div className="rounded-lg border bg-card/70 p-5">
          <SiteNotificationMarkdown markdown={message || DEFAULT_MESSAGE} />
        </div>
      </div>
    </div>
  );
}
