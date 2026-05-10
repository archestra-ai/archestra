"use client";

import type { Permissions } from "@shared/permission.types";
import { Megaphone } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useActiveSiteAnnouncement } from "@/lib/site-announcement.query";
import { cn } from "@/lib/utils";

const SITE_ANNOUNCEMENT_READ_PERMISSION: Permissions = {
  siteAnnouncement: ["read"],
};

export function SiteAnnouncementBanner() {
  const { data: canRead, isSuccess } = useHasPermissions(
    SITE_ANNOUNCEMENT_READ_PERMISSION,
  );
  const { data: announcement } = useActiveSiteAnnouncement(
    isSuccess && !!canRead,
  );

  if (!canRead || !announcement) {
    return null;
  }

  return (
    <div className="border-b border-border bg-accent/55 px-4 py-2 text-sm text-accent-foreground">
      <div className="mx-auto flex max-w-6xl items-start gap-2">
        <Megaphone className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-0 [&_ul]:my-0 [&_ul]:list-inside [&_ul]:list-disc">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
            components={{
              a: ({ className, ...props }) => (
                <a
                  className={cn(
                    "font-medium underline underline-offset-4",
                    className,
                  )}
                  rel="noreferrer"
                  target="_blank"
                  {...props}
                />
              ),
            }}
          >
            {announcement.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
