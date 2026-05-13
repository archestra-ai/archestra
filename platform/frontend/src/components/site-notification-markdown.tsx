"use client";

import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const markdownComponents: Components = {
  p: ({ node, ...props }) => <p className="leading-6" {...props} />,
  a: ({ node, ...props }) => (
    <a
      className="font-medium underline underline-offset-4 hover:text-foreground"
      {...props}
    />
  ),
  ul: ({ node, ...props }) => (
    <ul className="ml-5 list-disc space-y-1" {...props} />
  ),
  ol: ({ node, ...props }) => (
    <ol className="ml-5 list-decimal space-y-1" {...props} />
  ),
  li: ({ node, ...props }) => <li className="leading-6" {...props} />,
  strong: ({ node, ...props }) => (
    <strong className="font-semibold" {...props} />
  ),
  em: ({ node, ...props }) => <em className="italic" {...props} />,
  code: ({ node, ...props }) => (
    <code
      className="rounded bg-background/80 px-1 py-0.5 font-mono text-[0.85em]"
      {...props}
    />
  ),
};

interface SiteNotificationMarkdownProps {
  markdown: string;
  className?: string;
}

export function SiteNotificationMarkdown({
  markdown,
  className,
}: SiteNotificationMarkdownProps) {
  return (
    <div
      className={cn(
        "min-w-0 space-y-2 text-sm text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
