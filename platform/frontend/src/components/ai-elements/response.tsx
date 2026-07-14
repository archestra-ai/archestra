"use client";

import { type ComponentProps, memo, useMemo } from "react";
import { defaultRemarkPlugins, Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

type ResponseProps = ComponentProps<typeof Streamdown> & {
  isStreaming?: boolean;
};

// An app's standalone-page link with the leading slash dropped (`a/<uuid>`).
// A weak model sometimes emits this instead of `/a/<uuid>`; left as-is it
// resolves against the chat path (`/chat/<id>/a/...`) instead of the app page.
const APP_LINK_WITHOUT_LEADING_SLASH =
  /^a\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Repair that exact owned-app shape at the markdown (mdast) stage — before
// rehype-harden, which without a base origin blocks a slash-less relative link
// and renders it as `[blocked]`. Scoped to inline `link` nodes — the shape the
// model actually produces; every other node (images, code, reference
// definitions) is left untouched.
function canonicalizeAppLinkNode(node: unknown): void {
  if (node === null || typeof node !== "object") return;
  const link = node as { type?: unknown; url?: unknown; children?: unknown };
  if (
    link.type === "link" &&
    typeof link.url === "string" &&
    APP_LINK_WITHOUT_LEADING_SLASH.test(link.url)
  ) {
    link.url = `/${link.url}`;
  }
  if (Array.isArray(link.children)) {
    for (const child of link.children) canonicalizeAppLinkNode(child);
  }
}

const remarkCanonicalizeAppLinks = () => (tree: unknown) =>
  canonicalizeAppLinkNode(tree);

// streamdown exports its defaults as a name-keyed record; passing remarkPlugins
// replaces them, so re-include the defaults and append our repair.
const REMARK_PLUGINS: ResponseProps["remarkPlugins"] = [
  ...Object.values(defaultRemarkPlugins),
  remarkCanonicalizeAppLinks,
];

/**
 * Check if a URL points to the same origin as the current page.
 * Same-origin links should bypass the "Open external link?" confirmation dialog.
 */
export function isSameOriginUrl(url: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

export const Response = memo(
  ({ className, linkSafety, isStreaming = false, ...props }: ResponseProps) => {
    const mergedLinkSafety = useMemo(
      () => ({
        enabled: true,
        ...linkSafety,
        onLinkCheck: async (url: string) => {
          if (isSameOriginUrl(url)) return true;
          if (linkSafety?.onLinkCheck) return linkSafety.onLinkCheck(url);
          return false;
        },
      }),
      [linkSafety],
    );

    return (
      <Streamdown
        mode={isStreaming ? "streaming" : "static"}
        isAnimating={isStreaming}
        animated={isStreaming ? { animation: "fadeIn", sep: "word" } : false}
        caret={isStreaming ? "block" : undefined}
        controls={{
          code: { copy: true, download: true },
          table: { copy: true, download: true },
        }}
        className={cn(
          "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          // Add proper list styling
          "[&_ul]:list-inside [&_ul]:list-disc [&_ul]:ml-6 [&_ul]:my-2",
          "[&_ol]:list-inside [&_ol]:list-decimal [&_ol]:ml-6 [&_ol]:my-2",
          "[&_li]:my-1 [&_li>p]:inline",
          // Add proper heading styling
          "[&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-4",
          "[&_h2]:text-xl [&_h2]:font-bold [&_h2]:my-3",
          "[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:my-2",
          // Add proper paragraph spacing
          "[&_p]:my-2",
          // Add proper code block styling
          // Only style inline code, not code inside pre elements
          "[&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:text-foreground [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:rounded",
          "[&_pre]:bg-muted [&_pre]:p-3 [&_pre]:rounded [&_pre]:my-2 [&_pre]:overflow-x-auto",
          // Fix streamdown code blocks - remove padding from code elements inside them
          "[&_[data-streamdown='code-block']_code]:p-0 [&_[data-streamdown='code-block']_code]:bg-transparent",
          // Keep large markdown tables readable without letting them dominate the chat scroll.
          "[&_[data-streamdown='table-wrapper']>div:last-child]:max-h-[420px]",
          "[&_[data-streamdown='table-header']]:sticky [&_[data-streamdown='table-header']]:top-0 [&_[data-streamdown='table-header']]:z-10",
          // Fix button link styling - use group variant to match parent's is-user/is-assistant class
          "group-[.is-user]:[&_[data-streamdown='link']]:text-primary-foreground",
          "group-[.is-assistant]:[&_[data-streamdown='link']]:text-secondary-foreground",
          className,
        )}
        remarkPlugins={REMARK_PLUGINS}
        linkSafety={mergedLinkSafety}
        {...props}
      />
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.isStreaming === nextProps.isStreaming,
);

Response.displayName = "Response";
