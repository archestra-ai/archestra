"use client";

import { Check, Copy, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";

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
      <div className="flex items-center gap-3 px-5 py-4 font-mono text-[13px] text-[#f87171]">
        <span>Couldn&apos;t generate the command.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 border-[#1f2937] bg-transparent text-xs text-[#e5e7eb] hover:bg-[#1f2937] hover:text-white"
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (pending || !command) {
    return (
      <div className="flex items-center gap-2.5 px-5 py-4 font-mono text-[13px] text-[#9ca3af]">
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
        className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded border border-[#1f2937] bg-[#0d1117] text-[#9ca3af] transition-colors hover:text-white"
      >
        {copied ? (
          <Check className="size-3.5 text-[#4ade80]" strokeWidth={2.5} />
        ) : (
          <Copy className="size-3.5" strokeWidth={2} />
        )}
      </button>
      <pre className="m-0 overflow-x-auto px-5 py-4 pr-12 font-mono text-[13px] leading-[1.65] text-[#e5e7eb]">
        {command}
      </pre>
    </div>
  );
}
