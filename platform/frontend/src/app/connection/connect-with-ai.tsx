"use client";

import { Check, Copy, Terminal } from "lucide-react";
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
      <div className="overflow-hidden rounded-lg border bg-muted/30">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Terminal className="size-3.5" />
            <span>Prompt your agent</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={!origin}
            className="h-7 gap-2 text-xs text-foreground"
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
            <span>{copied ? "Copied" : "Copy prompt"}</span>
          </Button>
        </div>
        <div className="flex gap-4 px-5 py-7 sm:px-6">
          <span
            aria-hidden="true"
            className="select-none font-mono text-primary"
          >
            ›
          </span>
          <code className="min-w-0 break-words font-mono text-sm leading-7 sm:text-base">
            {origin ? prompt : "Loading your connection prompt…"}
          </code>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Requires Node.js 18+ and terminal access in {client.label}.
      </p>
    </div>
  );
}
