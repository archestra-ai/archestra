"use client";

import {
  E2eTestId,
  MCP_DEFAULT_LOG_LINES,
  type McpDeploymentStatusEntry,
  type McpLogsEndedMessage,
  type McpLogsErrorMessage,
  type McpLogsMessage,
  type ResourceVisibilityScope,
} from "@archestra/shared";
import {
  ArrowDown,
  Check,
  ChevronsUpDown,
  Copy,
  Globe,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { LogConsole } from "@/components/log-console";
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
import { copyToClipboard } from "@/lib/clipboard";
import { useAnimatedDots } from "@/lib/hooks/use-animated-dots";
import websocketService from "@/lib/websocket/websocket";
import {
  type DeploymentState,
  DeploymentStatusDot,
  getDeploymentLabel,
} from "./deployment-status";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { hasNoPodToStream } from "./logs-streaming-indicator";
// SPDX-SnippetEnd
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
    /**
     * Whether the viewer may present this install's credential upstream — its
     * own connection, or one shared with it. Only the Inspector cares: it
     * authenticates as the install, so it offers no one else's connection.
     * Optional so callers that never reach the Inspector can omit it.
     */
    canUseCredential?: boolean;
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

  // Reset when dialog closes so the next open picks up a fresh initialServerId.
  useEffect(() => {
    if (!isActive) {
      setServerId(null);
    }
  }, [isActive]);

  // The Inspector connects to the upstream as the selected install, signed
  // with that install's stored credential — so it only offers connections the
  // viewer may actually use. Logs and Shell read the pod rather than
  // authenticate as it, and keep the full list an installation admin needs.
  const selectableInstalls = useMemo(
    () =>
      activeTab === "inspector"
        ? installs.filter((i) => i.canUseCredential !== false)
        : installs,
    [activeTab, installs],
  );

  // Default to initialServerId or first installation when dialog opens.
  useEffect(() => {
    if (!isActive || selectableInstalls.length === 0) return;
    if (serverId && selectableInstalls.some((i) => i.id === serverId)) return;
    const initial =
      initialServerId &&
      selectableInstalls.some((i) => i.id === initialServerId)
        ? initialServerId
        : selectableInstalls[0].id;
    setServerId(initial);
  }, [isActive, selectableInstalls, serverId, initialServerId]);

  // Switching to the Inspector while someone else's connection is selected
  // leaves the stale id until the effect above re-defaults; render nothing
  // against it in the meantime.
  const inspectorServerId =
    serverId && selectableInstalls.some((i) => i.id === serverId)
      ? serverId
      : null;

  const currentDeploymentStatus = serverId
    ? deploymentStatuses[serverId]
    : null;

  // Streaming animation for when waiting for logs
  const isDeploymentFailed = currentDeploymentStatus?.state === "failed";
  const isWaitingForLogs = isStreaming && !streamedLogs && !streamError;
  const streamingText = useStreamingAnimation(isWaitingForLogs);
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // Hibernated/waking deployments (and any status with pod telemetry cleared)
  // have no pod to tail — show a muted "No pod" instead of the red chip.
  const noPodToStream = hasNoPodToStream(currentDeploymentStatus);
  // SPDX-SnippetEnd

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

  const handleCopyCommand = useCallback(async () => {
    try {
      await copyToClipboard(command);
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
          <div className="flex items-center gap-2 min-w-0">
            <DialogTitle className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
              <Terminal className="h-5 w-5 flex-shrink-0" />
              <span className="truncate">{serverName}</span>
            </DialogTitle>
          </div>
        </DialogHeader>
      )}

      {/* Pod selector */}
      {!hideInstallationSelector && selectableInstalls.length >= 1 && (
        <InstanceSelector
          installs={selectableInstalls}
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
                <div className="flex items-center gap-2">
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
                  {/* The installation card above already says Failed and why;
                      the fix sits here beside the evidence instead of in a
                      third status panel. */}
                  {isDeploymentFailed && onReinstall && serverId && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isReinstalling}
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
              </div>

              <LogConsole
                className="flex-1"
                scrollAreaRef={scrollAreaRef}
                content={isWaitingForLogs ? "" : streamedLogs}
                contentTestId={E2eTestId.McpLogsContent}
                errorTestId={E2eTestId.McpLogsError}
                error={
                  streamError ? `Error loading logs: ${streamError}` : null
                }
                placeholder={
                  isWaitingForLogs ? (
                    <div className="text-emerald-400 font-mono text-sm">
                      {streamingText}
                    </div>
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
                  ) : undefined
                }
                status={
                  /* SPDX-SnippetBegin */
                  /* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */
                  /* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */
                  noPodToStream ? (
                    <div className="flex items-center gap-1.5 text-slate-500 text-xs font-mono">
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-slate-600" />
                      <span>No pod</span>
                    </div>
                  ) : // SPDX-SnippetEnd
                  isStreaming && !streamError ? (
                    <div className="flex items-center gap-1.5 text-red-400 text-xs font-mono">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                      </span>
                      <span>Streaming</span>
                    </div>
                  ) : null
                }
              />
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
                    aria-label="Copy command"
                    className="absolute top-1/2 -translate-y-1/2 right-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                  >
                    <Copy className="h-3 w-3" />
                    {commandCopied ? <span> Copied!</span> : null}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="inspector" className={contentTabClassName}>
          {inspectorServerId ? (
            <McpInspector
              serverId={inspectorServerId}
              isActive={activeTab === "inspector" && isActive}
            />
          ) : (
            installs.length > 0 && (
              <div
                className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
                data-testid={E2eTestId.McpInspectorNoConnection}
              >
                <p className="text-sm font-medium">
                  No connection of yours to inspect
                </p>
                <p className="max-w-md text-xs text-muted-foreground">
                  The Inspector calls the server as the selected connection,
                  with that connection's credentials — so it only offers your
                  own connections and ones shared with you. Connect{" "}
                  <strong>{serverName}</strong> yourself, or ask for a shared
                  connection, to inspect it.
                </p>
              </div>
            )
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
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // Hibernated and waking share the calm muted treatment: waking is the same
  // idle pod on its way back, not a problem and not an amber "Starting".
  const isIdleOrWaking =
    selectedStatus?.state === "hibernated" ||
    selectedStatus?.state === "waking";
  // SPDX-SnippetEnd
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

  const hasMultiple = installs.length > 1;

  const card = (
    <div
      className={`group relative w-full rounded-lg border border-border/60 bg-card transition-all duration-200 ${
        hasMultiple
          ? "cursor-pointer hover:border-border hover:shadow-sm data-[state=open]:border-foreground/30 data-[state=open]:shadow-md"
          : ""
      }`}
      data-state={open ? "open" : "closed"}
    >
      <div className="flex items-stretch">
        {/* Identity block */}
        <div className="flex items-center gap-3 min-w-0 flex-1 pl-4 pr-3 py-3">
          <DeploymentStatusDot state={dotState} />
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-sm font-medium truncate leading-tight">
                {selected?.name ?? "—"}
              </span>
            </div>
            {stateLabel && (
              <span
                className={`text-[10px] tracking-[0.08em] leading-tight mt-0.5 ${
                  isFailed
                    ? "text-destructive"
                    : isRunning
                      ? "text-emerald-600 dark:text-emerald-400"
                      : /* SPDX-SnippetBegin */
                        /* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */
                        /* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */
                        isIdleOrWaking
                        ? "text-muted-foreground"
                        : /* SPDX-SnippetEnd */ "text-amber-600 dark:text-amber-400"
                }`}
              >
                {stateLabel}
              </span>
            )}
            {isFailed && selectedStatus?.error && (
              <span
                className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                title={selectedStatus.error}
              >
                {selectedStatus.error}
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
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-xs font-medium truncate">
                        {install.name}
                      </span>
                    </div>
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
