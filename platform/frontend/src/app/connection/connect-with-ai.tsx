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
  const prompt = `Read ${origin}/connect.md and connect ${client.label}.`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Paste this prompt into {client.label}. Review and approve the setup in
        your browser.
      </p>
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
  );
}
