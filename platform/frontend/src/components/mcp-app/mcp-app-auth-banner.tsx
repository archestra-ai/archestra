"use client";

import { ExternalLink, KeyRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConnectableAuthState } from "@/lib/chat/mcp-error-ui";

/**
 * Host-side connect affordance for an MCP App whose proxied tool call failed
 * with an auth error. Rendered by the host OUTSIDE the sandboxed iframe, so it
 * works for every app — including ones that only print the error text — and
 * the link opens even though the iframe sandbox blocks popups.
 */
export function McpAppAuthBanner({
  authState,
  onDismiss,
}: {
  authState: ConnectableAuthState;
  onDismiss: () => void;
}) {
  const expired = authState.kind === "auth-expired";
  const name = authState.catalogName || "this tool's server";
  const url = expired ? authState.reauthUrl : authState.actionUrl;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <KeyRound className="size-4 flex-none text-amber-600" />
      <span className="min-w-0 flex-1 text-foreground">
        {expired ? (
          <>
            Credentials for &ldquo;{name}&rdquo; have expired. Re-authenticate,
            then retry in the app.
          </>
        ) : (
          <>
            &ldquo;{name}&rdquo; is not connected. Connect it, then retry in the
            app.
          </>
        )}
      </span>
      <Button variant="secondary" size="sm" asChild>
        <a href={url} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="size-3.5" />
          {expired ? "Re-authenticate" : `Connect ${name}`}
        </a>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 text-muted-foreground"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
