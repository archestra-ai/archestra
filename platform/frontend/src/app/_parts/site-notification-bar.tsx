"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { usePublicConfig } from "@/lib/config/config.query";

const STORAGE_PREFIX = "site-notification-dismissed:";

/**
 * Instance-wide banner driven by ARCHESTRA_SITE_NOTIFICATION_MESSAGE
 * (surfaced via public config). The dismissal id is derived from the content,
 * so a changed message reappears after a previous one was dismissed.
 */
export function EnvSiteNotificationBar() {
  const { data: publicConfig } = usePublicConfig();
  const message = publicConfig?.siteNotificationMessage;

  if (!message) {
    return null;
  }

  return (
    <SiteNotificationBar
      content={message}
      notificationId={`env-${contentHash(message)}`}
    />
  );
}

interface SiteNotificationBarProps {
  content: string;
  notificationId: string;
}

export function SiteNotificationBar({
  content,
  notificationId,
}: SiteNotificationBarProps) {
  const [dismissed, setDismissed] = useState(() =>
    isNotificationDismissed(notificationId),
  );

  useEffect(() => {
    setDismissed(isNotificationDismissed(notificationId));
  }, [notificationId]);

  if (dismissed) {
    return null;
  }

  const handleDismiss = () => {
    markNotificationDismissed(notificationId);
    setDismissed(true);
  };

  return (
    <div className="sticky top-0 z-40 border-b border-primary bg-primary text-primary-foreground shadow-sm">
      <div className="flex items-start gap-3 px-6 py-2">
        <div className="flex-1 text-sm [&_a]:font-medium [&_a]:underline [&_a]:underline-offset-2 [&_h1]:my-0 [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:leading-5 [&_h2]:my-0 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:leading-5 [&_p]:my-0 [&_strong]:font-semibold">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 p-0 text-primary-foreground hover:bg-primary-foreground hover:text-primary"
          onClick={handleDismiss}
          aria-label="Dismiss notification"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function isNotificationDismissed(notificationId: string) {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(`${STORAGE_PREFIX}${notificationId}`) === "true";
}

function markNotificationDismissed(notificationId: string) {
  localStorage.setItem(`${STORAGE_PREFIX}${notificationId}`, "true");
}

function contentHash(content: string) {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
