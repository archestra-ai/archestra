"use client";

import {
  E2eTestId,
  MCP_DEFAULT_LOG_LINES,
  type McpDeploymentStatusEntry,
  type McpLogsEndedMessage,
  type McpLogsErrorMessage,
  type McpLogsMessage,
} from "@archestra/shared";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDeploymentLogAutoScroll } from "@/components/deployment-console";
import { ScrollArea } from "@/components/ui/scroll-area";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import websocketService from "@/lib/websocket/websocket";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { hasNoPodToStream } from "./logs-streaming-indicator";
// SPDX-SnippetEnd
import {
  ConsoleState,
  connState,
  Pulse,
  StatusItem,
} from "./mcp-server-console-ui";

export type LogStream = ReturnType<typeof useLogStream>;

export function useLogStream(serverId: string | null) {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [wrap, setWrap] = useState(false);
  const { scrollAreaRef, showScrollToBottom, scrollToBottom, followNewOutput } =
    useDeploymentLogAutoScroll();
  const unsubsRef = useRef<(() => void)[]>([]);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const receivedRef = useRef(false);
  const currentRef = useRef<string | null>(null);

  const teardown = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    for (const u of unsubsRef.current) u();
    unsubsRef.current = [];
    if (currentRef.current) {
      websocketService.send({
        type: "unsubscribe_mcp_logs",
        payload: { serverId: currentRef.current },
      });
    }
    currentRef.current = null;
  }, []);

  useEffect(() => {
    if (!serverId) {
      setContent("");
      setError(null);
      setCommand("");
      setIsStreaming(false);
      return;
    }
    // Deferred one tick so a dev StrictMode mount/unmount/mount never opens
    // (and immediately closes) a first stream whose "ended" reply would then
    // land on the real one.
    let started = false;
    const deferred = setTimeout(() => {
      started = true;
      teardown();
      setError(null);
      setContent("");
      setCommand("");
      setIsStreaming(true);
      receivedRef.current = false;
      currentRef.current = serverId;
      websocketService.connect();

      timeoutRef.current = setTimeout(() => {
        if (currentRef.current !== serverId) return;
        if (websocketService.isConnected() && receivedRef.current) return;
        setError("Connection timeout - unable to connect to server");
        setIsStreaming(false);
      }, 10000);

      const clearTimer = () => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
      };

      unsubsRef.current = [
        websocketService.subscribe("mcp_logs", (m: McpLogsMessage) => {
          if (m.payload.serverId !== serverId) return;
          receivedRef.current = true;
          clearTimer();
          if (m.payload.command) setCommand(m.payload.command);
          setContent((prev) => prev + m.payload.logs);
          followNewOutput();
        }),
        websocketService.subscribe(
          "mcp_logs_error",
          (m: McpLogsErrorMessage) => {
            if (m.payload.serverId !== serverId) return;
            clearTimer();
            // Shown inline in the console and status bar; no toast on top.
            setError(m.payload.error);
            setIsStreaming(false);
          },
        ),
        websocketService.subscribe(
          "mcp_logs_ended",
          (m: McpLogsEndedMessage) => {
            if (m.payload.serverId !== serverId) return;
            setIsStreaming(false);
          },
        ),
      ];

      websocketService.send({
        type: "subscribe_mcp_logs",
        payload: { serverId, lines: MCP_DEFAULT_LOG_LINES },
      });
    }, 0);

    return () => {
      clearTimeout(deferred);
      if (started) teardown();
      setIsStreaming(false);
    };
  }, [serverId, teardown, followNewOutput]);

  const lines = useMemo(() => {
    if (!content) return [];
    const all = content.split("\n");
    if (all[all.length - 1] === "") all.pop();
    return all;
  }, [content]);

  return {
    content,
    lines,
    lineCount: lines.length,
    error,
    command,
    isStreaming,
    wrap,
    setWrap,
    scrollAreaRef,
    showScrollToBottom,
    scrollToBottom,
  };
}

export function LogsStatus({
  logs,
  status,
}: {
  logs: LogStream;
  status: McpDeploymentStatusEntry | undefined;
}) {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const noPod = hasNoPodToStream(status);
  // SPDX-SnippetEnd
  return (
    <>
      <StatusItem>
        {noPod ? (
          <>
            <Pulse tone="off" />
            <span>No pod</span>
          </>
        ) : status?.state === "failed" && logs.lineCount === 0 ? (
          <>
            <Pulse tone="err" />
            <span className="text-red-400">Deploy failed</span>
          </>
        ) : status?.state === "pending" && logs.lineCount === 0 ? (
          <>
            <Pulse tone="warn" />
            <span className="text-amber-300">Waiting for pod</span>
          </>
        ) : logs.error ? (
          <>
            <Pulse tone="err" />
            <span className="text-red-400">Stream failed</span>
          </>
        ) : logs.isStreaming ? (
          <>
            <Pulse tone="rec" />
            <span className="text-emerald-400">Streaming</span>
          </>
        ) : (
          <>
            <Pulse tone="off" />
            <span>Stream ended</span>
          </>
        )}
      </StatusItem>
      {logs.lineCount > 0 && (
        <StatusItem hideBelow="sm">
          <span className="tabular-nums text-slate-300">
            {formatCount(logs.lineCount)}
          </span>
          <span>lines</span>
        </StatusItem>
      )}
      {logs.lineCount > 0 &&
        (logs.showScrollToBottom ? (
          <UnstyledButton
            onClick={logs.scrollToBottom}
            className="flex shrink-0 items-center gap-1 text-amber-300 hover:text-amber-200"
          >
            <ArrowDown className="size-3" />
            <span>Paused</span>
            <span className="hidden sm:inline">· jump to latest</span>
          </UnstyledButton>
        ) : (
          <StatusItem hideBelow="md">
            <span className="text-slate-500">following</span>
          </StatusItem>
        ))}
    </>
  );
}

export function LogsBody({
  logs,
  status,
  noPod,
}: {
  logs: LogStream;
  status: McpDeploymentStatusEntry | undefined;
  noPod: boolean;
}) {
  if (noPod) {
    const cs = connState(status);
    return (
      <ConsoleState
        tone="info"
        title={
          cs === "hibernated"
            ? "Scaled down while idle"
            : cs === "waking"
              ? "Waking from idle"
              : "Not deployed"
        }
        detail={
          cs === "hibernated" || cs === "waking"
            ? "There's no pod to tail right now. Logs stream again once it's back up."
            : "This connection has no pod yet, so there's nothing to tail. Logs appear once it's deployed."
        }
      />
    );
  }
  if (logs.lineCount === 0 && status?.state === "pending") {
    return (
      <ConsoleState
        tone="loading"
        title={`Waiting for the pod${status.message ? ` · ${status.message}` : ""}`}
        detail="The container hasn't started yet. Logs stream in as soon as it does."
      />
    );
  }
  if (logs.error && !(logs.lineCount === 0 && status?.state === "failed")) {
    return (
      <ConsoleState
        tone="error"
        title="Couldn't load logs"
        detail={
          <span data-testid={E2eTestId.McpLogsError}>
            Error loading logs: {logs.error}
          </span>
        }
      />
    );
  }
  if (logs.lineCount === 0) {
    if (status?.state === "failed" && status.error) {
      return (
        <ConsoleState
          tone="error"
          title={`Deployment failed${status.message ? ` · ${status.message}` : ""}`}
          detail={
            <>
              <span className="mb-2 block rounded border border-red-400/20 bg-red-400/5 px-2.5 py-1.5 text-left font-mono text-[11px] text-red-300/90">
                {status.error}
              </span>
              No container logs could be read. Its events say why it keeps
              restarting:{" "}
              <code className="font-mono text-slate-300">
                kubectl describe pod {status.podName ?? "<pod>"}
              </code>
            </>
          }
        />
      );
    }
    if (logs.isStreaming) {
      return (
        <ConsoleState
          tone="loading"
          title="Attaching to the log stream"
          detail={`Tailing the last ${MCP_DEFAULT_LOG_LINES} lines from the pod.`}
        />
      );
    }
    return (
      <ConsoleState
        tone="info"
        title="No logs yet"
        detail="The server hasn't written anything to stdout or stderr."
      />
    );
  }

  const gutter = String(logs.lineCount).length;
  return (
    <ScrollArea
      ref={logs.scrollAreaRef}
      className={cn(
        "min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block",
        // Unwrapped lines scroll sideways instead of being clipped.
        !logs.wrap && "[&_[data-slot=scroll-area-viewport]]:!overflow-x-auto",
      )}
    >
      <div
        data-testid={E2eTestId.McpLogsContent}
        className={cn(
          "py-2 font-mono text-xs leading-5",
          !logs.wrap && "w-max min-w-full",
        )}
        style={{ ["--gutter" as string]: `${gutter + 3}ch` }}
      >
        {logs.lines.map((line, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: log lines are append-only
            key={i}
            data-n={i + 1}
            className={cn(
              // The line number is a sticky ::before gutter, so it stays put
              // while long lines scroll and never ends up in a copied selection.
              "flex pr-4 hover:bg-slate-900/70",
              "before:sticky before:left-0 before:w-(--gutter) before:flex-none before:bg-slate-950 before:pr-3 before:text-right before:text-slate-600 before:select-none before:content-[attr(data-n)] hover:before:bg-[#0b1222]",
              logs.wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
              lineTone(line),
            )}
          >
            {line || " "}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function lineTone(line: string) {
  if (/\b(error|fatal|panic|exception|traceback)\b/i.test(line))
    return "text-red-300";
  if (/\bwarn(ing)?\b/i.test(line)) return "text-amber-200";
  if (/^\s*[{[]/.test(line)) return "text-slate-400";
  return "text-slate-200";
}

function formatCount(n: number) {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}
