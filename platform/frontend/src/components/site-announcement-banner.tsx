"use client";

import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { useActiveSiteAnnouncement } from "@/lib/site-announcement.query";

const markdownComponents: Components = {
  p: ({ children }) => <span>{children}</span>,
  a: ({ children, href }) => (
    <a
      href={href}
      className="font-medium underline underline-offset-2 hover:text-primary"
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em>{children}</em>,
};

export function SiteAnnouncementBanner() {
  const { data: announcement, isPending } = useActiveSiteAnnouncement();

  if (isPending || !announcement?.markdown) {
    return null;
  }

  return (
    <div className="w-full border-b border-border bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950/25 dark:text-amber-100">
      <div className="mx-auto flex max-w-5xl items-center justify-center text-center leading-5 [&_*]:inline">
        <ReactMarkdown
          allowedElements={["p", "a", "strong", "em", "text"]}
          unwrapDisallowed
          components={markdownComponents}
        >
          {announcement.markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}
