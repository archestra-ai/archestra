"use client";

import { KeyRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <KeyRound className="mt-0.5 size-4 flex-none text-amber-600" />
      <span className="min-w-0 flex-1 break-words text-foreground">
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
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 flex-none text-muted-foreground"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
