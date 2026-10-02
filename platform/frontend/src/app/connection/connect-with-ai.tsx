"use client";

import {
  buildConnectionPrompt,
  hasNativeSetupSession,
} from "@archestra/shared/connection-setup";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { copyToClipboard } from "@/lib/clipboard";
import { useConnectionPromptSession } from "@/lib/connection-setup.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import type { ConnectClient } from "./clients";

export function ConnectWithAi({ client }: { client: ConnectClient }) {
  const appName = useAppName();
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const connectionClientId = hasNativeSetupSession(client.id)
    ? client.id
    : undefined;
  const { isError, refetch } = useConnectionPromptSession(
    connectionClientId,
    origin,
  );
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  const prompt = buildConnectionPrompt({
    origin,
    clientId: client.id,
    label: client.label,
  });

  return (
    <div className="space-y-4">
      {client.id === "cursor" && (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>Using {appName} for Cursor&apos;s AI requests</AlertTitle>
          <AlertDescription>
            <p>
              Connecting Cursor here adds {appName} tools and skills. Cursor
              keeps using its current models. To route supported OpenAI requests
              through {appName} too, choose LLM Proxy under Customize setup.
            </p>
            <p>
              After setup, find “Cursor model settings (manual step)” in the
              installer output. It shows the proxy URL and, if selected, a
              virtual key. Otherwise use your own OpenAI API key. In Cursor
              Settings → Models → API Keys, enter those values and turn on Use
              OpenAI API Key and Override OpenAI Base URL. A Cursor subscription
              cannot be used as a key.
            </p>
          </AlertDescription>
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">
        Paste this prompt into {client.label}. Review and approve the setup in
        your browser.
      </p>
      {connectionClientId && isError && (
        <InlineNotice variant="error">
          <TriangleAlert />
          <span className="font-medium">Could not start connection setup.</span>
          <InlineNoticeText>Retry before you copy the prompt.</InlineNoticeText>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => refetch()}
          >
            Retry
          </Button>
        </InlineNotice>
      )}
      <div className="space-y-2">
        <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
          <code className="min-w-0 flex-1 break-words font-mono text-sm leading-6">
            {origin ? prompt : "Loading your connection prompt…"}
          </code>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!origin}
            className="shrink-0"
            aria-label={copied ? "Copied" : "Copy prompt"}
            title={copied ? "Copied" : "Copy prompt"}
            onClick={async () => {
              try {
                if (connectionClientId) {
                  const refreshed = await refetch();
                  if (
                    refreshed.isError ||
                    !refreshed.data ||
                    Date.parse(refreshed.data.expiresAt) <= Date.now()
                  ) {
                    toast.error("Could not start connection setup. Retry.");
                    return;
                  }
                }
                await copyToClipboard(prompt);
                setCopied(true);
              } catch {
                toast.error(
                  "Could not copy. Select the prompt and copy it manually.",
                );
              }
            }}
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Requires Node.js 18+ and terminal access in {client.label}.
        </p>
      </div>
    </div>
  );
}
