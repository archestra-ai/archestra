"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { useAppearanceSettings } from "@/lib/organization.query";
import { Button } from "./ui/button";

const DISMISSED_KEY = "site-announcement-dismissed";

/**
 * Returns the current active announcement if one exists and hasn't expired.
 * Returns null if no announcement or it's expired.
 */
function useActiveAnnouncement() {
  const { data: appearance } = useAppearanceSettings();

  const content = appearance?.siteAnnouncementContent;
  const expiresAt = appearance?.siteAnnouncementExpiresAt;

  if (!content) return null;

  if (expiresAt) {
    const expiry = new Date(expiresAt);
    if (expiry < new Date()) return null;
  }

  return content;
}

export function SiteNotificationBanner() {
  const announcement = useActiveAnnouncement();
  const [dismissed, setDismissed] = useState(false);

  // Check if this announcement was already dismissed
  useEffect(() => {
    if (!announcement) return;
    try {
      const stored = sessionStorage.getItem(DISMISSED_KEY);
      if (stored === announcement) {
        setDismissed(true);
      }
    } catch {
      // sessionStorage not available
    }
  }, [announcement]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISSED_KEY, announcement ?? "");
    } catch {
      // sessionStorage not available
    }
  }, [announcement]);

  if (!announcement || dismissed) {
    return null;
  }

  return (
    <div
      data-testid="site-notification-banner"
      className="bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-800 text-blue-900 dark:text-blue-100 px-4 py-2 flex items-center justify-between gap-4"
    >
      <div className="text-sm prose prose-sm dark:prose-invert max-w-none flex-1 [&_a]:underline [&_a]:text-blue-700 dark:[&_a]:text-blue-300">
        <ReactMarkdown rehypePlugins={[rehypeSanitize]}>
          {announcement}
        </ReactMarkdown>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100 hover:bg-blue-100 dark:hover:bg-blue-900/40"
        onClick={handleDismiss}
        aria-label="Dismiss announcement"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
