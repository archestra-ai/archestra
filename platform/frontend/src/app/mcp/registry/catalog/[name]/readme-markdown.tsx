"use client";

import "highlight.js/styles/github-dark.css";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

export function ReadmeMarkdown({ content }: { content: string }) {
  return (
    <div className="github-markdown">
      <style>{`
        .github-markdown pre code.hljs {
          background: transparent !important;
          color: inherit !important;
        }
      `}</style>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeHighlight]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// Custom markdown components for GitHub-like styling
const commonClasses = "max-w-[800px]";
const markdownComponents: Components = {
  h1: ({ node, ...props }) => (
    <h1
      className={`text-2xl font-semibold text-foreground mt-6 mb-4 pb-2 border-b border-border ${commonClasses}`}
      {...props}
    />
  ),
  h2: ({ node, ...props }) => (
    <h2
      className={`text-xl font-semibold text-foreground mt-6 mb-4 pb-2 border-b border-border ${commonClasses}`}
      {...props}
    />
  ),
  h3: ({ node, ...props }) => (
    <h3
      className={`text-lg font-semibold text-foreground mt-6 mb-3 ${commonClasses}`}
      {...props}
    />
  ),
  h4: ({ node, ...props }) => (
    <h4
      className={`text-base font-semibold text-foreground mt-4 mb-2 ${commonClasses}`}
      {...props}
    />
  ),
  p: ({ node, ...props }) => (
    <p
      className={`text-muted-foreground leading-relaxed mb-2 text-left break-words ${commonClasses}`}
      {...props}
    />
  ),
  a: ({ node, ...props }) => (
    <a
      className={`inline-block text-primary hover:underline break-all ${commonClasses}`}
      {...props}
    />
  ),
  code: ({ node, ...props }) => (
    <code
      className={`bg-muted text-destructive px-1.5 py-0.5 rounded text-sm font-mono break-words ${commonClasses}`}
      {...props}
    />
  ),
  pre: ({ node, ...props }) => (
    <pre
      className={`bg-muted/50 border rounded-lg p-4 overflow-x-auto text-sm mb-4 text-foreground ${commonClasses}`}
      {...props}
    />
  ),
  blockquote: ({ node, ...props }) => (
    <blockquote
      className={`border-l-4 border-border pl-4 text-muted-foreground italic my-4 ${commonClasses}`}
      {...props}
    />
  ),
  table: ({ node, ...props }) => (
    <div className={`overflow-x-auto my-6 ${commonClasses}`}>
      <table
        className="w-full border-collapse border border-border text-sm"
        {...props}
      />
    </div>
  ),
  tr: ({ node, ...props }) => {
    // Filter out valign prop to avoid React warning
    // biome-ignore lint/suspicious/noExplicitAny: Props from react-markdown can have legacy HTML attributes
    const { valign, vAlign, ...cleanProps } = props as any;
    // Use the filtered props to avoid React warnings about legacy attributes
    void valign;
    void vAlign;
    return <tr {...cleanProps} />;
  },
  th: ({ node, ...props }) => (
    <th
      className={`bg-muted font-semibold text-left px-3 py-2 border border-border ${commonClasses}`}
      {...props}
    />
  ),
  td: ({ node, ...props }) => (
    <td
      className={`px-3 py-2 border border-border align-top ${commonClasses}`}
      {...props}
    />
  ),
  ul: ({ node, ...props }) => (
    <ul
      className={`list-disc pl-6 mb-4 space-y-1 ${commonClasses}`}
      {...props}
    />
  ),
  ol: ({ node, ...props }) => (
    <ol
      className={`list-decimal pl-6 mb-4 space-y-1 ${commonClasses}`}
      {...props}
    />
  ),
  li: ({ node, ...props }) => (
    <li className={`text-muted-foreground ${commonClasses}`} {...props} />
  ),
  img: ({ node, ...props }) => (
    <img
      className={`inline-block align-middle mr-1 h-auto max-w-full ${commonClasses}`}
      alt=""
      {...props}
    />
  ),
  hr: ({ node, ...props }) => (
    <hr className={`border-border my-8 ${commonClasses}`} {...props} />
  ),
  strong: ({ node, ...props }) => (
    <strong
      className={`font-semibold text-foreground ${commonClasses}`}
      {...props}
    />
  ),
};
