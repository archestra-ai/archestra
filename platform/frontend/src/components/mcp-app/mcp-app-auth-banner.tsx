"use client";

import { KeyRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import type { ConnectableAuthState } from "@/lib/chat/mcp-error-ui";

/**
 * Host-side connect affordance for an MCP App whose proxied tool call failed
 * with an auth error. Rendered by the host OUTSIDE the sandboxed iframe, so it
 * works for every app — including ones that only print the error text — and
 * the link opens even though the iframe sandbox blocks popups.
 *
 * Deliberately mirrors the SDK's error prose (`Tool "x" requires
 * authentication — open <url>`) with the url clickable, rather than
 * paraphrasing it away into a vague "connect the server" line.
 */
export function McpAppAuthBanner({
  toolName,
  authState,
  onDismiss,
}: {
  toolName: string;
  authState: ConnectableAuthState;
  onDismiss: () => void;
}) {
  const expired = authState.kind === "auth-expired";
  const url = expired ? authState.reauthUrl : authState.actionUrl;

  return (
    <InlineNotice className="mb-2 items-start">
      <KeyRound className="mt-0.5" />
      <InlineNoticeText className="flex-1 break-words">
        Tool &ldquo;{toolName}&rdquo; requires{" "}
        {expired ? "re-authentication" : "authentication"} &mdash; open{" "}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all font-medium underline underline-offset-2"
        >
          {url}
        </a>
      </InlineNoticeText>
      <Button
        variant="ghost"
        size="icon"
        className="ml-auto size-6 flex-none text-muted-foreground"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </Button>
    </InlineNotice>
  );
}
