"use client";

import { ArrowDown, Copy } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

interface LogViewerProps {
  logs: string;
  error?: string | null;
  isStreaming?: boolean;
  label?: string;
}

/**
 * Hook that returns an animated "Streaming" text with cycling dots
 */
function useStreamingAnimation(isActive: boolean) {
  const [dotCount, setDotCount] = useState(0);

  useEffect(() => {
    if (!isActive) {
      setDotCount(0);
      return;
    }

    const interval = setInterval(() => {
      setDotCount((prev) => (prev + 1) % 4);
    }, 400);

    return () => clearInterval(interval);
  }, [isActive]);

  return useMemo(() => {
    const dots = ".".repeat(dotCount);
    const spaces = "\u00A0".repeat(3 - dotCount);
    return `Streaming${dots}${spaces}`;
  }, [dotCount]);
}

export function LogViewer({
  logs,
  error,
  isStreaming = false,
  label = "Logs",
}: LogViewerProps) {
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  const isWaitingForLogs = isStreaming && !logs && !error;
  const streamingText = useStreamingAnimation(isWaitingForLogs);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(logs);
      setCopied(true);
      toast.success("Logs copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy logs");
    }
  }, [logs]);

  const scrollToBottom = useCallback(() => {
    if (scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current.querySelector(
        "[data-radix-scroll-area-viewport]",
      );
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        setAutoScroll(true);
      }
    }
  }, []);

  // Auto-scroll on content changes + detect manual scroll-up
  useEffect(() => {
    const scrollContainer = scrollAreaRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]",
    );
    if (!scrollContainer) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
      const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10;
      setAutoScroll(isAtBottom);
    };

    // Use MutationObserver to auto-scroll when content changes
    const observer = new MutationObserver(() => {
      if (autoScroll) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    });
    observer.observe(scrollContainer, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    scrollContainer.addEventListener("scroll", handleScroll);
    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
      observer.disconnect();
    };
  }, [autoScroll]);

  return (
    <div className="flex flex-col gap-2 flex-1 min-h-0">
      <div className="flex items-center justify-between flex-shrink-0">
        <h3 className="text-sm font-semibold">{label}</h3>
        {!autoScroll && (
          <Button
            variant="outline"
            size="sm"
            onClick={scrollToBottom}
            className="bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100"
          >
            <ArrowDown className="mr-2 h-3 w-3" />
            Scroll to Bottom
          </Button>
        )}
      </div>

      <div className="flex flex-col flex-1 min-h-0 rounded-md border bg-slate-950 overflow-hidden">
        <ScrollArea ref={scrollAreaRef} className="flex-1 overflow-auto">
          <div className="p-4">
            {error ? (
              <div className="text-red-400 font-mono text-sm">
                Error loading logs: {error}
              </div>
            ) : isWaitingForLogs ? (
              <div className="text-emerald-400 font-mono text-sm">
                {streamingText}
              </div>
            ) : logs ? (
              <pre className="text-emerald-400 font-mono text-xs whitespace-pre-wrap">
                {logs}
              </pre>
            ) : (
              <div className="text-slate-400 font-mono text-sm">
                No logs available
              </div>
            )}
          </div>
        </ScrollArea>
        <div className="flex items-center justify-between px-3 py-2 border-t border-slate-800">
          {isStreaming && !error ? (
            <div className="flex items-center gap-1.5 text-red-400 text-xs font-mono">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
              </span>
              Streaming
            </div>
          ) : (
            <div />
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            disabled={!!error || !logs}
            className="h-6 px-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          >
            <Copy className="h-3 w-3 mr-1" />
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>
      </div>
    </div>
  );
}
