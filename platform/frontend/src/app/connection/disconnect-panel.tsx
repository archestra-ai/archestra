"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyToClipboard } from "@/lib/clipboard";
import type { ConnectClient } from "./clients";

/**
 * Copy-paste prompt that removes everything the setup added to a client.
 *
 * MOCK: `/disconnect.md` doesn't exist yet; it would reuse the startup guard's
 * reverse steps.
 */
export function DisconnectPanel({ client }: { client: ConnectClient }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  const prompt = `Read ${origin}/disconnect.md?client=${encodeURIComponent(client.id)} and disconnect ${client.label} from Archestra.`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Paste this prompt into {client.label}. It removes the gateway&apos;s MCP
        entry, the LLM Proxy settings, and the skills and plugins the setup
        installed. Nothing else in {client.label} is touched.
      </p>
      <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
        <code className="min-w-0 flex-1 break-words font-mono text-sm leading-6">
          {origin ? prompt : "Loading your disconnect prompt…"}
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
    </div>
  );
}

/** The footer's "disconnect" link opens this, so the page itself never shifts. */
export function DisconnectDialog({
  client,
  open,
  onOpenChange,
}: {
  client: ConnectClient;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Disconnect {client.label}</DialogTitle>
          <DialogDescription>
            Run this whenever you want to undo the setup.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <DisconnectPanel client={client} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
