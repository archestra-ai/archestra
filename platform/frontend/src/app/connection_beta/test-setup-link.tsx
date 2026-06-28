"use client";

import { ArrowRight, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CopyableCode } from "@/components/copyable-code";
import { Button } from "@/components/ui/button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";

/**
 * Final verify step for the Claude Code / Claude Desktop proxy setup. Always
 * shows a copyable sample message carrying a one-off marker token for the user
 * to send. The "Test your setup" link deep-links to the LLM logs filtered (by
 * `search`) to exactly that message — so the user proves their own request
 * routed through the proxy. The link renders only for users who can open the
 * logs page (gated on `log:read`); without it the link would only land them on
 * a Forbidden page.
 *
 * The token is generated once on the client per mount, so it is unique across
 * everything that produces a distinct mount: client, user, keys, gateway,
 * proxy, and each page load. That uniqueness is what lets the link pin the
 * exact session with the search term alone — no `sessionSource` filter needed.
 */
export function TestSetupStep() {
  const appName = useAppName();
  const { data: session } = useSession();
  const { data: canReadLogs } = useHasPermissions({ log: ["read"] });
  const userId = session?.user?.id;

  // Client-only so the random token never differs between SSR and hydration
  // (same pattern the panel uses for platform detection).
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    setToken(generateTestMarker());
  }, []);

  if (!token) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Preparing your test message…
      </div>
    );
  }

  const message = `Testing my ${appName} connection — please reply "OK". (test id: ${token})`;

  // The marker is unique enough to pin the exact session on its own, so the
  // link only carries the search term (plus the user scope). We deliberately
  // omit sessionSource, whose client detection is unreliable.
  const params = new URLSearchParams({ search: token });
  if (userId) params.set("userId", userId);

  return (
    <div className="grid gap-2">
      <div data-testid="connect-sample-message">
        <CopyableCode
          value={message}
          variant="primary"
          toastMessage="Sample message copied"
        >
          <span className="block break-words text-xs text-foreground">
            {message}
          </span>
        </CopyableCode>
      </div>
      {/*
       * Verifying means opening the logs page, which is gated on log:read — show
       * the "Test your setup" link only to users who can actually get there.
       */}
      {canReadLogs && (
        <div>
          <Button
            asChild
            variant="outline"
            size="sm"
            data-testid="connect-test-setup-link"
          >
            <Link href={`/llm/logs?${params.toString()}`}>
              Test your setup
              <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

/** Short, collision-resistant, easily-searchable marker for the sample message. */
function generateTestMarker(): string {
  return `conn-test-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
