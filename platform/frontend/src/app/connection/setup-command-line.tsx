"use client";

import { Check, Copy, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  terminalActionClass,
  terminalCodeClass,
} from "@/components/terminal-surface";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export function SetupCommandLine({
  command,
  pending,
  failed,
  onRetry,
}: {
  command: string | null;
  pending: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    if (!command) return;
    await copyToClipboard(command);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 1600);
  }, [command]);

  if (failed) {
    return (
      <div className="flex items-center gap-3 px-5 py-4 font-mono text-[13px] text-terminal-destructive">
        <span>Couldn&apos;t generate the command.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 border-terminal-edge bg-transparent text-xs text-terminal-foreground hover:bg-terminal-elevated hover:text-terminal-emphasis"
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (pending || !command) {
    return (
      <div className="flex items-center gap-2.5 px-5 py-4 font-mono text-[13px] text-terminal-muted">
        <Loader2 className="size-3.5 animate-spin" />
        <span>Generating command…</span>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy to clipboard"
        className={cn(
          terminalActionClass,
          "absolute right-2 top-1/2 size-7 -translate-y-1/2",
        )}
      >
        {copied ? (
          <Check className="size-3.5 text-terminal-success" strokeWidth={2.5} />
        ) : (
          <Copy className="size-3.5" strokeWidth={2} />
        )}
      </button>
      <pre
        className={cn("m-0 overflow-x-auto px-5 py-4 pr-12", terminalCodeClass)}
      >
        {command}
      </pre>
    </div>
  );
}
