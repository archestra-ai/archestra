"use client";

import type { ReactNode } from "react";
import { useAttachmentContentUrl } from "@/lib/chat/locked-chat-attachment";
import { cn } from "@/lib/utils";

/**
 * Renderers for a chat attachment's bytes.
 *
 * In an ordinary chat these are the plain `<img>` / `<video>` / `<a>` they
 * wrap. In a locked chat the bytes only come back to a request carrying the
 * conversation key, which the DOM will not attach on its own, so each of these
 * waits on {@link useAttachmentContentUrl} to fetch them and swap in a `blob:`
 * URL. That wait is the only reason they exist as components.
 */

export function AttachmentImage({
  url,
  conversationId,
  alt,
  className,
}: {
  url: string;
  conversationId: string | null | undefined;
  alt: string;
  className?: string;
}) {
  const resolved = useAttachmentContentUrl(url, conversationId);

  if (resolved.failed) {
    return <AttachmentUnavailable className={className} />;
  }
  if (!resolved.url) {
    return (
      <div
        className={cn("h-32 w-32 animate-pulse rounded-lg bg-muted", className)}
      />
    );
  }
  return <img src={resolved.url} alt={alt} className={className} />;
}

export function AttachmentVideo({
  url,
  conversationId,
  className,
}: {
  url: string;
  conversationId: string | null | undefined;
  className?: string;
}) {
  const resolved = useAttachmentContentUrl(url, conversationId);

  if (resolved.failed) {
    return <AttachmentUnavailable className={className} />;
  }
  if (!resolved.url) {
    return (
      <div
        className={cn(
          "h-32 w-full animate-pulse rounded-lg bg-muted",
          className,
        )}
      />
    );
  }
  return (
    <video src={resolved.url} controls className={className}>
      <track kind="captions" />
    </video>
  );
}

/**
 * A download/open link for an attachment. While a sealed attachment is still
 * being fetched the anchor renders inert rather than disappearing, so the
 * chip's size and the filename beside it do not jump.
 */
export function AttachmentLink({
  url,
  conversationId,
  download,
  className,
  children,
}: {
  url: string;
  conversationId: string | null | undefined;
  download?: string;
  className?: string;
  children: ReactNode;
}) {
  const resolved = useAttachmentContentUrl(url, conversationId);

  if (!resolved.url) {
    return (
      <span
        className={cn(className, "cursor-default opacity-60")}
        aria-disabled="true"
      >
        {children}
      </span>
    );
  }
  return (
    <a
      href={resolved.url}
      target="_blank"
      rel="noopener noreferrer"
      download={download}
      className={className}
    >
      {children}
    </a>
  );
}

function AttachmentUnavailable({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center rounded-lg border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground",
        className,
      )}
    >
      This file can&apos;t be opened in this browser.
    </div>
  );
}
