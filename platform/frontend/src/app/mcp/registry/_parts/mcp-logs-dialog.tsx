"use client";

import {
  E2eTestId,
  MCP_DEFAULT_LOG_LINES,
  type McpDeploymentStatusEntry,
  type McpLogsEndedMessage,
  type McpLogsErrorMessage,
  type McpLogsMessage,
  type ResourceVisibilityScope,
} from "@shared";
import {
  ArrowDown,
  Check,
  ChevronsUpDown,
  Copy,
  Globe,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAnimatedDots } from "@/lib/hooks/use-animated-dots";
import websocketService from "@/lib/websocket/websocket";
import {
  type DeploymentState,
  DeploymentStatusDot,
  getDeploymentLabel,
} from "./deployment-status";
import { McpExecTerminal } from "./mcp-exec-terminal";
import { McpInspector } from "./mcp-inspector";

interface McpLogsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  installs: {
    id: string;
    name: string;
    ownerEmail?: string | null;
    teamDetails?: { teamId: string; name: string } | null;
    scope?: ResourceVisibilityScope | null;
  }[];
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  /** Hide the installation dropdown selector */
  hideInstallationSelector?: boolean;
  /** Called when user clicks Reinstall for a specific server */
  onReinstall?: (serverId: string) => void | Promise<void>;
  /** Pre-select a specific server when opening */
  initialServerId?: string | null;
}

/**
 * Hook that returns an animated "Streaming" text with cycling dots
 */
function useStreamingAnimation(isActive: boolean) {
  const dots = useAnimatedDots(isActive);
  return `Streaming${dots}`;
}

export function McpLogsDialog({
  open,
  onOpenChange,
  serverName,
  installs,
  deploymentStatuses,
  hideInstallationSelector = false,
  onReinstall,
  initialServerId = null,
}: McpLogsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-5xl h-[85vh] flex flex-col p-8"
        data-testid={E2eTestId.McpLogsDialog}
      >
        <McpLogsContent
          isActive={open}
          serverName={serverName}
          installs={installs}
          deploymentStatuses={deploymentStatuses}
          hideInstallationSelector={hideInstallationSelector}
          onReinstall={onReinstall}
          initialServerId={initialServerId}
        />
      </DialogContent>
    </Dialog>
  );
}

export type McpLogsTab = "logs" | "debug" | "inspector";

interface McpLogsContentProps {
  isActive: boolean;
  serverName: string;
  installs: McpLogsDialogProps["installs"];
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  hideInstallationSelector?: boolean;
  hideHeader?: boolean;
  /** When set, controls the active tab externally */
  controlledTab?: McpLogsTab;
  /** When true, hides the tab bar (use with controlledTab) */
  hideTabBar?: boolean;
  onReinstall?: (serverId: string) => void | Promise<void>;
  initialServerId?: string | null;
}

export function McpLogsContent({
  isActive,
  serverName,
  installs,
  deploymentStatuses,
  hideInstallationSelector = false,
  hideHeader = false,
  controlledTab,
  hideTabBar = false,
  onReinstall,
  initialServerId = null,
}: McpLogsContentProps) {
  const [internalTab, setInternalTab] = useState<McpLogsTab>("logs");
  const activeTab = controlledTab ?? internalTab;
  const setActiveTab = (tab: McpLogsTab) => {
    if (!controlledTab) setInternalTab(tab);
  };
  const [copied, setCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [streamedLogs, setStreamedLogs] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isReinstalling, setIsReinstalling] = useState(false);
  const unsubscribeLogsRef = useRef<(() => void) | null>(null);
  const unsubscribeErrorRef = useRef<(() => void) | null>(null);
  const unsubscribeEndedRef = useRef<(() => void) | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const hasReceivedMessageRef = useRef(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const currentServerIdRef = useRef<string | null>(null);

  // State for selected installation
  const [serverId, setServerId] = useState<string | null>(null);

  // Reset when dialog closes so the next open picks up a fresh initialServerId
  useEffect(() => {
    if (!isActive) {
      setServerId(null);
    }
  }, [isActive]);

  // Default to initialServerId or first installation when dialog opens
  useEffect(() => {
    if (isActive && installs.length > 0 && !serverId) {
      const initial =
        initialServerId && installs.some((i) => i.id === initialServerId)
          ? initialServerId
          : installs[0].id;
      setServerId(initial);
    }
  }, [isActive, installs, serverId, initialServerId]);

  const currentDeploymentStatus = serverId
    ? deploymentStatuses[serverId]
    : null;

  // Streaming animation for when waiting for logs
  const isDeploymentFailed = currentDeploymentStatus?.state === "failed";
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
    if (unsubscribeEndedRef.current) {
      unsubscribeEndedRef.current();
      unsubscribeEndedRef.current = null;
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

  const startStreaming = useCallback((targetServerId: string) => {
    // Clean up existing stream without resetting UI state (we set it all below)
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    if (unsubscribeLogsRef.current) {
      unsubscribeLogsRef.current();
      unsubscribeLogsRef.current = null;
    }
    if (unsubscribeErrorRef.current) {
      unsubscribeErrorRef.current();
      unsubscribeErrorRef.current = null;
    }
    if (unsubscribeEndedRef.current) {
      unsubscribeEndedRef.current();
      unsubscribeEndedRef.current = null;
    }
    if (currentServerIdRef.current) {
      websocketService.send({
        type: "unsubscribe_mcp_logs",
        payload: { serverId: currentServerIdRef.current },
      });
    }

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
          if (autoScrollRef.current) {
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

    // Subscribe to stream ended messages for this server
    unsubscribeEndedRef.current = websocketService.subscribe(
      "mcp_logs_ended",
      (message: McpLogsEndedMessage) => {
        if (message.payload.serverId !== targetServerId) return;
        setIsStreaming(false);
      },
    );

    // Send subscribe message to server
    websocketService.send({
      type: "subscribe_mcp_logs",
      payload: { serverId: targetServerId, lines: MCP_DEFAULT_LOG_LINES },
    });
  }, []);

  // Auto-start streaming when dialog opens or serverId changes
  useEffect(() => {
    if (isActive && serverId) {
      startStreaming(serverId);
    }
  }, [isActive, serverId, startStreaming]);

  // Clean up when dialog closes
  useEffect(() => {
    if (!isActive) {
      stopStreaming();
      setStreamedLogs("");
      setStreamError(null);
      setCommand("");
      autoScrollRef.current = true;
      setAutoScroll(true);
      setServerId(null); // Reset selection so it picks first on reopen
      setInternalTab("logs");
    }
  }, [isActive, stopStreaming]);

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
      autoScrollRef.current = isAtBottom;
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
        autoScrollRef.current = true;
        setAutoScroll(true);
      }
    }
  }, []);

  const isDebugDisabled = currentDeploymentStatus?.state !== "running";
  const contentTabClassName = hideHeader
    ? "flex flex-1 min-h-0 flex-col pt-4"
    : "mt-2 flex flex-1 min-h-0 flex-col";

  return (
    <>
      {!hideHeader && (
        <DialogHeader className="flex-shrink-0">
          <div className="min-w-0">
            <DialogTitle className="flex items-center gap-2 overflow-hidden">
              <Terminal className="h-5 w-5 flex-shrink-0" />
              <span className="truncate">{serverName}</span>
            </DialogTitle>
          </div>
        </DialogHeader>
      )}

      {/* Pod selector */}
      {!hideInstallationSelector && installs.length >= 1 && (
        <InstanceSelector
          installs={installs}
          deploymentStatuses={deploymentStatuses}
          serverId={serverId}
          setServerId={setServerId}
        />
      )}

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "logs" | "debug" | "inspector")}
        className="flex flex-col flex-1 min-h-0"
      >
        {!hideTabBar && (
          <TabsList className="w-fit bg-slate-100 dark:bg-slate-800 border h-9 p-1 flex-shrink-0">
            <TabsTrigger
              value="logs"
              data-testid={E2eTestId.McpLogsTab}
              className="px-6"
            >
              Logs
            </TabsTrigger>
            {isDebugDisabled ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <TabsTrigger value="inspector" disabled className="px-6">
                      Inspector
                    </TabsTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Pod must be running to inspect tools
                </TooltipContent>
              </Tooltip>
            ) : (
              <TabsTrigger value="inspector" className="px-6">
                Inspector
              </TabsTrigger>
            )}
            {isDebugDisabled ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <TabsTrigger value="debug" disabled className="px-6">
                      Shell
                    </TabsTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Pod must be running to start a shell session
                </TooltipContent>
              </Tooltip>
            ) : (
              <TabsTrigger value="debug" className="px-6">
                Shell
              </TabsTrigger>
            )}
          </TabsList>
        )}

        <TabsContent value="logs" className={contentTabClassName}>
          <div className="flex flex-col gap-4 flex-1 min-h-0">
            <div className="flex flex-col gap-2 flex-1 min-h-0">
              {isDeploymentFailed && currentDeploymentStatus?.error && (
                <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 flex-shrink-0">
                  <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive/15 text-destructive flex-shrink-0">
                    <span className="text-sm font-bold">✕</span>
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-destructive">
                      Deployment failed
                    </p>
                    <p className="text-sm text-destructive/80 break-words">
                      {currentDeploymentStatus.error}
                    </p>
                  </div>
                  {onReinstall && serverId && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isReinstalling}
                      className="flex-shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10"
                      onClick={async () => {
                        setIsReinstalling(true);
                        try {
                          await onReinstall(serverId);
                        } finally {
                          setIsReinstalling(false);
                        }
                        startStreaming(serverId);
                      }}
                    >
                      <RefreshCw
                        className={`h-3 w-3 mr-1.5 ${isReinstalling ? "animate-spin" : ""}`}
                      />
                      {isReinstalling ? "Reinstalling..." : "Reinstall"}
                    </Button>
                  )}
                </div>
              )}
              <div className="flex items-center justify-between flex-shrink-0">
                <h3 className="text-sm font-semibold">
                  Pod Logs
                  {currentDeploymentStatus?.podName && (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      for {currentDeploymentStatus.podName}
                    </span>
                  )}
                </h3>
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
                <ScrollArea
                  ref={scrollAreaRef}
                  className="flex-1 overflow-auto"
                >
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
                    ) : isDeploymentFailed && currentDeploymentStatus?.error ? (
                      <div className="text-red-400 font-mono text-sm">
                        <div className="mb-2">
                          Deployment failed: {currentDeploymentStatus.error}
                        </div>
                        <div className="text-slate-400">
                          No container logs available. Use the manual command
                          below to inspect the pod.
                        </div>
                      </div>
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
        </TabsContent>

        <TabsContent value="inspector" className={contentTabClassName}>
          {serverId && (
            <McpInspector
              serverId={serverId}
              isActive={activeTab === "inspector" && isActive}
            />
          )}
        </TabsContent>

        <TabsContent value="debug" className={contentTabClassName}>
          {serverId && (
            <McpExecTerminal
              serverId={serverId}
              isActive={activeTab === "debug" && isActive}
            />
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

interface InstanceSelectorProps {
  installs: McpLogsContentProps["installs"];
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  serverId: string | null;
  setServerId: (id: string) => void;
}

function InstanceSelector({
  installs,
  deploymentStatuses,
  serverId,
  setServerId,
}: InstanceSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected = installs.find((i) => i.id === serverId);
  const selectedStatus = serverId ? deploymentStatuses[serverId] : undefined;
  const dotState = (
    selectedStatus?.state === "not_created" ||
    selectedStatus?.state === "succeeded"
      ? "running"
      : (selectedStatus?.state ?? "pending")
  ) as DeploymentState;
  const isFailed = selectedStatus?.state === "failed";
  const isRunning =
    selectedStatus?.state === "running" ||
    selectedStatus?.state === "succeeded";
  const stateLabel =
    selectedStatus && selectedStatus.state !== "not_created"
      ? getDeploymentLabel(
          (selectedStatus.state === "succeeded"
            ? "running"
            : selectedStatus.state) as DeploymentState,
        )
      : null;
  const isOrgScope = selected?.scope === "org";
  const owner = isOrgScope
    ? "Organization"
    : (selected?.teamDetails?.name ?? selected?.ownerEmail);
  const ownerInitials = (
    selected?.teamDetails?.name ||
    selected?.ownerEmail ||
    ""
  )
    .slice(0, 2)
    .toUpperCase();

  const accent = isFailed
    ? "bg-destructive"
    : isRunning
      ? "bg-emerald-500"
      : "bg-amber-500";

  const hasMultiple = installs.length > 1;

  const card = (
    <div
      className={`group relative w-full rounded-lg border transition-all duration-200 ${
        isFailed
          ? "border-destructive/30 bg-destructive/[0.02]"
          : "border-border/60 bg-card"
      } ${
        hasMultiple
          ? "cursor-pointer hover:border-border hover:shadow-sm data-[state=open]:border-foreground/30 data-[state=open]:shadow-md"
          : ""
      }`}
      data-state={open ? "open" : "closed"}
    >
      {/* Hairline accent, top */}
      <span
        className={`absolute left-4 right-4 top-0 h-px ${accent} opacity-60`}
      />

      <div className="flex items-stretch">
        {/* Identity block */}
        <div className="flex items-center gap-3 min-w-0 flex-1 pl-4 pr-3 py-3">
          <DeploymentStatusDot state={dotState} />
          <div className="flex flex-col min-w-0">
            <span className="font-mono text-sm font-medium truncate leading-tight">
              {selected?.name ?? "—"}
            </span>
            {stateLabel && (
              <span
                className={`text-[10px] tracking-[0.08em] leading-tight mt-0.5 ${
                  isFailed
                    ? "text-destructive"
                    : isRunning
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-amber-600 dark:text-amber-400"
                }`}
              >
                {stateLabel}
              </span>
            )}
          </div>
        </div>

        {/* Stats — separated by hairlines */}
        {owner && (
          <div className="hidden md:flex items-center gap-2 px-4 py-3 border-l border-border/40">
            {isOrgScope ? (
              <span className="flex items-center justify-center size-6 rounded-full bg-accent text-accent-foreground">
                <Globe className="h-3 w-3" />
              </span>
            ) : (
              <span
                className={`flex items-center justify-center size-6 rounded-full text-[10px] font-medium ${
                  selected?.teamDetails
                    ? "bg-accent text-accent-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {ownerInitials}
              </span>
            )}
            <span className="text-xs text-foreground/80 max-w-[140px] truncate">
              {owner}
            </span>
          </div>
        )}

        {selectedStatus?.restartCount !== undefined && (
          <div className="hidden lg:flex flex-col justify-center px-4 py-3 border-l border-border/40 min-w-[72px]">
            <span className="text-[9px] tracking-[0.08em] text-muted-foreground/60 leading-none">
              Restarts
            </span>
            <span className="font-mono text-sm tabular-nums mt-1 leading-none">
              {selectedStatus.restartCount}
            </span>
          </div>
        )}

        {selectedStatus?.podAge && (
          <div className="hidden lg:flex flex-col justify-center px-4 py-3 border-l border-border/40 min-w-[72px]">
            <span className="text-[9px] tracking-[0.08em] text-muted-foreground/60 leading-none">
              Age
            </span>
            <span className="font-mono text-sm tabular-nums mt-1 leading-none">
              {selectedStatus.podAge}
            </span>
          </div>
        )}

        {/* Chevron */}
        {hasMultiple && (
          <div className="flex items-center justify-center px-3 border-l border-border/40 text-muted-foreground/50 group-hover:text-foreground group-data-[state=open]:text-foreground transition-colors">
            <ChevronsUpDown className="h-3.5 w-3.5" />
          </div>
        )}
      </div>
    </div>
  );

  if (!hasMultiple) {
    return <div className="flex-shrink-0">{card}</div>;
  }

  return (
    <div className="flex-shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
            aria-label="Switch instance"
          >
            {card}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="p-0 w-[var(--radix-popover-trigger-width)] max-h-[320px] overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border/60 bg-muted/30 flex items-center justify-between">
            <span className="text-[10px] tracking-[0.08em] text-muted-foreground">
              Instances
            </span>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {installs.length}
            </span>
          </div>
          <div className="overflow-y-auto max-h-[280px] p-1">
            {installs.map((install) => {
              const s = deploymentStatuses[install.id];
              const d = (
                s?.state === "not_created" || s?.state === "succeeded"
                  ? "running"
                  : (s?.state ?? "pending")
              ) as DeploymentState;
              const io =
                install.scope === "org"
                  ? "Organization"
                  : (install.teamDetails?.name ?? install.ownerEmail);
              const age = s?.podAge;
              const isActive = install.id === serverId;

              return (
                <button
                  key={install.id}
                  type="button"
                  onClick={() => {
                    setServerId(install.id);
                    setOpen(false);
                  }}
                  className={`group/item relative w-full text-left rounded-md px-2.5 py-2 flex items-center gap-2.5 transition-colors ${
                    isActive ? "bg-muted/60" : "hover:bg-muted/40"
                  }`}
                >
                  <DeploymentStatusDot state={d} />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="font-mono text-xs font-medium truncate">
                      {install.name}
                    </span>
                    {(io || age) && (
                      <span className="text-[10px] text-muted-foreground truncate">
                        {[io, age].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </div>
                  {isActive && (
                    <Check className="h-3.5 w-3.5 text-foreground/70 flex-shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
