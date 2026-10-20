"use client";

import { memo, Suspense } from "react";
import { appInteractive } from "@/lib/app-interactive";
import { preloadableLazy } from "@/lib/utils/preloadable-lazy";
import { cn } from "@/lib/utils/tailwind";
import type { ResponseProps } from "./response-markdown";

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

const markdown = preloadableLazy(() => import("./response-markdown"));

/**
 * Fetch the markdown renderer ahead of need — a conversation page calls this
 * as it mounts, the new-chat composer on the first key or Send press, and
 * every other page on the first idle callback after it hydrates. The empty
 * new-chat screen shows no markdown, so it does not load it while idle.
 */
export const preloadResponseMarkdown = markdown.preload;

/** Hand over the renderer a page imported statically (see preloadableLazy). */
export const provideResponseMarkdown = markdown.provide;

if (typeof window !== "undefined" && window.location.pathname !== "/chat") {
  void appInteractive.whenIdle().then(preloadResponseMarkdown);
}

/**
 * Markdown for a message. The renderer (streamdown, its highlighter and
 * sanitizer) is a separate chunk; until it has loaded, the text shows as
 * plain, wrapped text in the same box, so nothing jumps when it swaps in.
 */
export const Response = memo(
  (props: ResponseProps) =>
    // A page that ships the renderer with its route (a conversation, whose
    // HTML holds its last messages) renders the markdown in the same pass.
    // Without a boundary of its own, the server sends the transcript with its
    // markdown in one piece rather than message by message, each swapping in
    // over its plain text and growing the transcript as it lands.
    markdown.isLoaded() ? (
      <markdown.Component {...props} />
    ) : (
      <Suspense fallback={<PlainResponse {...props} />}>
        <markdown.Component {...props} />
      </Suspense>
    ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.isStreaming === nextProps.isStreaming &&
    prevProps.preserveLineBreaks === nextProps.preserveLineBreaks,
);

Response.displayName = "Response";

function PlainResponse({ className, children }: ResponseProps) {
  return (
    <div className={cn("size-full whitespace-pre-wrap", className)}>
      {typeof children === "string" ? children : null}
    </div>
  );
}
