"use client";

import { Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * The app's log surface: a dark terminal-style panel with monospaced output, a
 * scroll region that owns its own height, and a footer that carries a copy
 * button plus whatever status the caller wants beside it (a streaming pulse, a
 * "no pod" note).
 *
 * Extracted from the MCP registry's pod-log viewer so every log readout —
 * pod logs, connector sync-run logs — reads the same instead of one being a
 * terminal and the next a pale `<pre>` wedged into a dialog.
 */
export function LogConsole({
  content,
  emptyMessage = "No logs available",
  placeholder,
  error,
  contentTone = "logs",
  copySuccessMessage = "Logs copied to clipboard",
  status,
  scrollAreaRef,
  onScroll,
  className,
  contentTestId,
  errorTestId,
}: {
  /** The log text. Empty or absent renders `placeholder`, else `emptyMessage`. */
  content: string | null | undefined;
  emptyMessage?: string;
  /**
   * What to show in place of the empty message while there is no log text yet
   * — a "connecting…" line, an explanation of why none exist. Not copyable:
   * it is the console's own commentary, not output from the thing being read.
   */
  placeholder?: React.ReactNode;
  /** Shown instead of the content — the logs could not be loaded at all. */
  error?: string | null;
  /** Visual tone for copyable content. Transport errors use the `error` prop. */
  contentTone?: "logs" | "error";
  copySuccessMessage?: string;
  /** Footer content on the left of the copy button (streaming indicator, …). */
  status?: React.ReactNode;
  scrollAreaRef?: React.Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  /** Sizing for the panel — callers pick a fixed height or `flex-1`. */
  className?: string;
  contentTestId?: string;
  errorTestId?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!content) return;
    try {
      await copyToClipboard(content);
      setCopied(true);
      toast.success(copySuccessMessage);
      setTimeout(() => setCopied(false), 2000);
    } catch (_error) {
      toast.error("Failed to copy logs");
    }
  }, [content, copySuccessMessage]);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-md border bg-slate-950",
        className,
      )}
    >
      <ScrollArea
        ref={scrollAreaRef}
        onScroll={onScroll}
        // Radix sizes the viewport's inner wrapper as a `display: table`, which
        // makes it grow to the widest line instead of wrapping inside the
        // panel. Logs are read wrapped, so force it back to a block.
        className="min-h-0 flex-1 overflow-auto [&_[data-radix-scroll-area-viewport]>div]:!block"
      >
        <div className="p-4">
          {error ? (
            <div
              className="font-mono text-sm text-red-400"
              data-testid={errorTestId}
            >
              {error}
            </div>
          ) : content ? (
            <pre
              className={cn(
                "font-mono text-xs whitespace-pre-wrap break-words",
                contentTone === "error" ? "text-red-400" : "text-emerald-400",
              )}
              data-testid={contentTestId}
            >
              {content}
            </pre>
          ) : (
            (placeholder ?? (
              <div className="font-mono text-sm text-slate-400">
                {emptyMessage}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
      <div className="flex items-center justify-between border-t border-slate-800 px-3 py-2">
        {status ?? <div />}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          disabled={!!error || !content}
          className="h-6 px-2 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        >
          <Copy className="mr-1 h-3 w-3" />
          {copied ? "Copied!" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
