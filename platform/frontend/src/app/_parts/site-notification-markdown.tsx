"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** The banner's markdown, loaded only when a banner is shown. */
export function SiteNotificationMarkdown({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
}
