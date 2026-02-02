"use client";

import {
  E2eTestId,
  MCP_DEFAULT_LOG_LINES,
  type McpLogsErrorMessage,
  type McpLogsMessage,
} from "@shared";
import { ArrowDown, Copy, Terminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import websocketService from "@/lib/websocket";

interface McpLogsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  installs: {
    id: string;
    name: string;
  }[];
  /** Hide the installation dropdown selector */
  hideInstallationSelector?: boolean;
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
    const spaces = "\u00A0".repeat(3 - dotCount); // Non-breaking spaces to maintain width
    return `Streaming${dots}${spaces}`;
  }, [dotCount]);
}

export function McpLogsDialog({
  open,
  onOpenChange,
  serverName,
  installs,
  hideInstallationSelector = false,
}: McpLogsDialogProps) {
  const [copied, setCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [streamedLogs, setStreamedLogs] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const unsubscribeLogsRef = useRef<(() => void) | null>(null);
  const unsubscribeErrorRef = useRef<(() => void) | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const hasReceivedMessageRef = useRef(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const currentServerIdRef = useRef<string | null>(null);

  // State for selected installation
  const [serverId, setServerId] = useState<string | null>(null);

  // Default to first installation when dialog opens
  useEffect(() => {
    if (open && installs.length > 0 && !serverId) {
      setServerId(installs[0].id);
    }
  }, [open, installs, serverId]);

  // Streaming animation for when waiting for logs
  const isWaitingForLogs = isStreaming && !streamedLogs && !streamError;
  const streamingText = useStreamingAnimation(isWaitingForLogs);

  const stopStreaming = useCallback(() => {
    // Clear connection timeout
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }

    // Unsubscribe from WebSocket messages
    if (unsubscribeLogsRef.current) {
      unsubscribeLogsRef.current();
      unsubscribeLogsRef.current = null;
    }
    if (unsubscribeErrorRef.current) {
      unsubscribeErrorRef.current();
      unsubscribeErrorRef.current = null;
    }

    // Send unsubscribe message to server
    if (currentServerIdRef.current) {
      websocketService.send({
        type: "unsubscribe_mcp_logs",
        payload: { serverId: currentServerIdRef.current },
      });
    }

    setIsStreaming(false);
    currentServerIdRef.current = null;
  }, []);

  const startStreaming = useCallback(
    (targetServerId: string) => {
      // Stop any existing stream first
      stopStreaming();

      setStreamError(null);
      setStreamedLogs("");
      setCommand("");
      setIsStreaming(true);
      hasReceivedMessageRef.current = false;
      currentServerIdRef.current = targetServerId;

      // Connect to WebSocket if not already connected
      websocketService.connect();

      // Set up connection timeout - if no logs received within 10 seconds, show error
      connectionTimeoutRef.current = setTimeout(() => {
        // Only trigger timeout if we're still streaming and haven't received any logs
        if (currentServerIdRef.current === targetServerId) {
          const isStillWaiting =
            !websocketService.isConnected() || !hasReceivedMessageRef.current;
          if (!isStillWaiting) {
            return;
          }
          setStreamError("Connection timeout - unable to connect to server");
          setIsStreaming(false);
        }
      }, 10000);

      // Subscribe to log messages for this server
      unsubscribeLogsRef.current = websocketService.subscribe(
        "mcp_logs",
        (message: McpLogsMessage) => {
          if (message.payload.serverId !== targetServerId) return;

          hasReceivedMessageRef.current = true;

          // Clear connection timeout on first message
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }

          // Capture the command from the first message
          if (message.payload.command) {
            setCommand(message.payload.command);
          }

          setStreamedLogs((prev) => {
            const newLogs = prev + message.payload.logs;

            // Auto-scroll to bottom when new logs arrive
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
        },
      );

      // Subscribe to error messages for this server
      unsubscribeErrorRef.current = websocketService.subscribe(
        "mcp_logs_error",
        (message: McpLogsErrorMessage) => {
          if (message.payload.serverId !== targetServerId) return;

          // Clear connection timeout on error
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }

          setStreamError(message.payload.error);
          toast.error(`Streaming failed: ${message.payload.error}`);
          setIsStreaming(false);
        },
      );

      // Send subscribe message to server
      websocketService.send({
        type: "subscribe_mcp_logs",
        payload: { serverId: targetServerId, lines: MCP_DEFAULT_LOG_LINES },
      });
    },
    [autoScroll, stopStreaming],
  );

  // Auto-start streaming when dialog opens or serverId changes
  useEffect(() => {
    if (open && serverId) {
      startStreaming(serverId);
    }
  }, [open, serverId, startStreaming]);

  // Clean up when dialog closes
  useEffect(() => {
    if (!open) {
      stopStreaming();
      setStreamedLogs("");
      setStreamError(null);
      setCommand("");
      setAutoScroll(true);
      setServerId(null); // Reset selection so it picks first on reopen
    }
  }, [open, stopStreaming]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopStreaming();
    };
  }, [stopStreaming]);

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

  const handleCopyLogs = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(streamedLogs);
      setCopied(true);
      toast.success("Logs copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch (_error) {
      toast.error("Failed to copy logs");
    }
  }, [streamedLogs]);

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-5xl h-[70vh] flex flex-col"
        data-testid={E2eTestId.McpLogsDialog}
      >
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2 overflow-hidden">
            <Terminal className="h-5 w-5 flex-shrink-0" />
            <span className="truncate">Logs: {serverName}</span>
          </DialogTitle>
          <DialogDescription className="flex flex-col gap-2">
            <span>View the recent logs from the MCP server deployment</span>
            {!hideInstallationSelector && installs.length > 1 && (
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Installation:</span>
                <Select
                  value={serverId ?? undefined}
                  onValueChange={setServerId}
                >
                  <SelectTrigger className="w-[300px] h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {installs.map((install) => (
                      <SelectItem key={install.id} value={install.id}>
                        {install.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 flex-1 min-h-0">
          <div className="flex flex-col gap-2 flex-1 min-h-0">
            <div className="flex items-center justify-between flex-shrink-0">
              <h3 className="text-sm font-semibold">Deployment Logs</h3>
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
                  {streamError ? (
                    <div
                      className="text-red-400 font-mono text-sm"
                      data-testid={E2eTestId.McpLogsError}
                    >
                      Error loading logs: {streamError}
                    </div>
                  ) : isWaitingForLogs ? (
                    <div className="text-emerald-400 font-mono text-sm">
                      {streamingText}
                    </div>
                  ) : streamedLogs ? (
                    <pre
                      className="text-emerald-400 font-mono text-xs whitespace-pre-wrap"
                      data-testid={E2eTestId.McpLogsContent}
                    >
                      {streamedLogs}
                    </pre>
                  ) : (
                    <div className="text-slate-400 font-mono text-sm">
                      No logs available
                    </div>
                  )}
                </div>
              </ScrollArea>
              <div className="flex items-center justify-between px-3 py-2 border-t border-slate-800">
                {isStreaming && !streamError ? (
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
                  onClick={handleCopyLogs}
                  disabled={!!streamError || !streamedLogs}
                  className="h-6 px-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                >
                  <Copy className="h-3 w-3 mr-1" />
                  {copied ? "Copied!" : "Copy"}
                </Button>
              </div>
            </div>
          </div>

          {command && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Manual Command</h3>
              <div className="relative">
                <ScrollArea className="rounded-md border bg-slate-950 p-3 pr-16">
                  <code className="text-emerald-400 font-mono text-xs break-all">
                    {command}
                  </code>
                </ScrollArea>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCopyCommand}
                  className="absolute top-1/2 -translate-y-1/2 right-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                >
                  <Copy className="h-3 w-3" />
                  {commandCopied ? " Copied!" : ""}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
