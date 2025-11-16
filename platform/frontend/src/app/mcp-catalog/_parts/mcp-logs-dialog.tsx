"use client";

import {
  ArrowDown,
  Copy,
  Play,
  RefreshCw,
  Square,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

interface McpLogsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  serverId?: string;
  logs: string;
  command: string;
  isLoading: boolean;
  error?: Error | null;
  onRefresh: () => unknown;
}

export function McpLogsDialog({
  open,
  onOpenChange,
  serverName,
  serverId,
  logs: initialLogs,
  command,
  isLoading: initialIsLoading,
  error: initialError,
  onRefresh,
}: McpLogsDialogProps) {
  const [copied, setCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [streamedLogs, setStreamedLogs] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Use streamed logs when following, otherwise use initial logs
  const displayLogs = isFollowing ? streamedLogs : initialLogs;
  const displayError = isFollowing ? streamError : initialError?.message;
  const displayIsLoading = isFollowing ? false : initialIsLoading;

  const startFollowing = useCallback(async () => {
    if (!serverId) {
      toast.error("Server ID is required for streaming logs");
      return;
    }

    setIsFollowing(true);
    setStreamError(null);

    // Create an abort controller for this stream
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch(
        `/api/mcp_server/${serverId}/logs?lines=500&follow=true`,
        {
          signal: abortController.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to stream logs: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("No response body");
      }

      // Clear existing logs when starting to follow
      setStreamedLogs("");

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        setStreamedLogs((prev) => {
          const newLogs = prev + chunk;

          // Auto-scroll to bottom when new logs arrive (with a slight delay to ensure DOM update)
          if (autoScroll) {
            setTimeout(() => {
              if (scrollAreaRef.current) {
                const scrollContainer = scrollAreaRef.current.querySelector(
                  "[data-radix-scroll-area-viewport]",
                );
                if (scrollContainer) {
                  scrollContainer.scrollTop = scrollContainer.scrollHeight;
                }
              }
            }, 10);
          }

          return newLogs;
        });
      }
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        setStreamError(err.message);
        toast.error(`Streaming failed: ${err.message}`);
      }
    } finally {
      setIsFollowing(false);
      abortControllerRef.current = null;
    }
  }, [serverId, autoScroll]);

  const stopFollowing = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsFollowing(false);
  }, []);

  // Auto-scroll management: detect when user scrolls up manually
  useEffect(() => {
    const scrollContainer = scrollAreaRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]",
    );

    if (!scrollContainer) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
      const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10; // 10px tolerance
      setAutoScroll(isAtBottom);
    };

    scrollContainer.addEventListener("scroll", handleScroll);
    return () => scrollContainer.removeEventListener("scroll", handleScroll);
  }, []);

  // Clean up when dialog closes
  useEffect(() => {
    if (!open) {
      stopFollowing();
      setStreamedLogs("");
      setStreamError(null);
      setAutoScroll(true); // Reset auto-scroll when dialog reopens
    }
  }, [open, stopFollowing]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopFollowing();
    };
  }, [stopFollowing]);

  const handleCopyLogs = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(displayLogs);
      setCopied(true);
      toast.success("Logs copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch (_error) {
      toast.error("Failed to copy logs");
    }
  }, [displayLogs]);

  const handleCopyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCommandCopied(true);
      toast.success("Command copied to clipboard");
      setTimeout(() => setCommandCopied(false), 2000);
    } catch (_error) {
      toast.error("Failed to copy command");
    }
  }, [command]);

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

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
      toast.success("Logs refreshed");
    } catch (_error) {
      toast.error("Failed to refresh logs");
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 overflow-hidden">
            <Terminal className="h-5 w-5 flex-shrink-0" />
            <span className="truncate">Logs: {serverName}</span>
          </DialogTitle>
          <DialogDescription>
            View the recent logs from the MCP server container
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 flex-1 min-h-0">
          {/* Logs section */}
          <div className="flex flex-col gap-2 flex-1 min-h-0">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Container Logs</h3>
              <div className="flex gap-2">
                {!isFollowing ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={startFollowing}
                      disabled={displayIsLoading || !serverId}
                    >
                      <Play className="mr-2 h-3 w-3" />
                      Follow
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleRefresh}
                      disabled={displayIsLoading || isRefreshing}
                    >
                      <RefreshCw
                        className={`mr-2 h-3 w-3 ${displayIsLoading || isRefreshing ? "animate-spin" : ""}`}
                      />
                      Refresh
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" onClick={stopFollowing}>
                    <Square className="mr-2 h-3 w-3" />
                    Stop
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyLogs}
                  disabled={displayIsLoading || !!displayError || !displayLogs}
                >
                  <Copy className="mr-2 h-3 w-3" />
                  {copied ? "Copied!" : "Copy"}
                </Button>
                {isFollowing && !autoScroll && (
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
            </div>

            <ScrollArea
              ref={scrollAreaRef}
              className="h-[450px] rounded-md border bg-slate-950"
            >
              <div className="p-4">
                {displayIsLoading ? (
                  <div className="text-slate-400 font-mono text-sm">
                    Loading logs...
                  </div>
                ) : displayError ? (
                  <div className="text-red-400 font-mono text-sm">
                    Error loading logs: {displayError}
                  </div>
                ) : displayLogs ? (
                  <pre className="text-slate-200 font-mono text-xs whitespace-pre-wrap">
                    {displayLogs}
                  </pre>
                ) : (
                  <div className="text-slate-400 font-mono text-sm">
                    No logs available
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Command section */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Manual Command</h3>
            <div className="relative">
              <ScrollArea className="rounded-md border bg-slate-950 p-3 pr-16">
                <code className="text-slate-200 font-mono text-xs break-all">
                  {command}
                </code>
              </ScrollArea>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyCommand}
                className="absolute top-1 right-1"
              >
                <Copy className="h-3 w-3" />
                {commandCopied ? "Copied!" : ""}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Run this command from your terminal to fetch the logs manually
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
