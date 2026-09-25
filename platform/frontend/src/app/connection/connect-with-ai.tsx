"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import type { ConnectClient } from "./clients";

export function ConnectWithAi({ client }: { client: ConnectClient }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  // The gateway remedy tools are unavailable before setup, so do not make
  // bootstrap depend on a guarded WebFetch result.
  const prompt =
    client.id === "claude-code"
      ? `Connect Claude Code to ${origin}. Do not fetch setup instructions or run an installer in this agent session. Ask me to open ${origin}/connection?clientId=claude-code in my browser, review the setup, and run the installer myself in a terminal on the computer where Claude Code is installed. I will approve the matching browser code and wait for it to finish. Then ask me to restart Claude Code, open /mcp in a new session, select the gateway, and authenticate in my browser. Do not claim success until the new session can list gateway tools. Never request passwords, cookies, or tokens in this conversation.`
      : `Connect ${client.label} to ${origin}. Do not fetch setup instructions. Run the command for your terminal (Node.js 18+ required):

macOS/Linux:
p="$(mktemp)"; trap 'rm -f "$p"' EXIT; curl --fail --silent --show-error ${origin}/api/client-connections/installer --output "$p" && node "$p" --url ${origin} --client ${client.id}

Windows PowerShell:
$p=[IO.Path]::GetTempFileName(); try { Invoke-WebRequest -UseBasicParsing -Uri ${origin}/api/client-connections/installer -OutFile $p; node $p --url ${origin} --client ${client.id} } finally { Remove-Item $p -Force -ErrorAction SilentlyContinue }

Allow at least 10 minutes for the command while the user approves the matching code in their browser. If the browser does not open, show the approval URL and code. Do not start another installer or replace this flow with manual API calls. After it finishes, follow its client-specific restart and MCP sign-in instructions. Verify the gateway and proxy in a new session before reporting success.`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Paste this prompt into {client.label}. Review and approve the setup in
        your browser.
      </p>
      <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-sm leading-6">
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
        {client.id === "claude-code"
          ? "Requires Node.js 18+ on the computer running Claude Code."
          : `Requires Node.js 18+ and terminal access in ${client.label}.`}
      </p>
    </div>
  );
}
