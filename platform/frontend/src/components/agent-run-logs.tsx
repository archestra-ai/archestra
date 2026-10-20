"use client";

import type {
  AgentRunLogsEndedMessage,
  AgentRunLogsErrorMessage,
  AgentRunLogsMessage,
} from "@archestra/shared";
import { FileX2, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { DeploymentLogPanel } from "@/components/deployment-console";
import { TerminalRecording } from "@/components/terminal-recording";
import type { AgentRun } from "@/lib/agent-runtime.query";
import websocketService from "@/lib/websocket/websocket";

export function AgentRunLogs({
  run,
  title = "Output",
  sessionId,
}: {
  run: AgentRun;
  title?: string;
  sessionId?: string;
}) {
  const includeSessionHistory = Boolean(sessionId);
  const logId = sessionId ?? run.taskId;
  const [terminalContent, setTerminalContent] = useState("");
  const [error, setError] = useState<string>();
  const [isStreaming, setIsStreaming] = useState(!run.endedAt);
  // An ended run's history is on its way until the server says it has ended:
  // until then the panel is loading, not empty.
  const [historyLoaded, setHistoryLoaded] = useState(!run.endedAt);
  const [retainedStatus, setRetainedStatus] = useState<{
    source: "full" | "tail";
    truncated: boolean;
  }>();

  useEffect(() => {
    let receivedOutput = false;
    let emptyRetryCount = 0;
    let emptyRetryTimer: ReturnType<typeof setTimeout> | undefined;
    // Frames are collected and rendered together: every render replays and
    // snapshots the whole recording, so one per frame (a long history is
    // dozens of frames) multiplied that work and the copies of the string.
    // An ended run's history renders once it has all arrived; a live run's
    // output at most every LIVE_FLUSH_MS.
    let received = "";
    let pending: string[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (pending.length === 0) return;
      received += pending.join("");
      pending = [];
      setTerminalContent(received);
    };
    const scheduleFlush = () => {
      if (run.endedAt) {
        // The end message flushes; this only covers one that never comes.
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, HISTORY_IDLE_FLUSH_MS);
      } else if (!flushTimer) {
        flushTimer = setTimeout(flush, LIVE_FLUSH_MS);
      }
    };
    const subscribeToLogs = () => {
      websocketService.send({
        type: "subscribe_agent_run_logs",
        payload: {
          runId: logId,
          ...(includeSessionHistory ? { includeSessionHistory: true } : {}),
        },
      });
    };
    setTerminalContent("");
    setError(undefined);
    setIsStreaming(!run.endedAt);
    setHistoryLoaded(!run.endedAt);
    setRetainedStatus(undefined);
    websocketService.connect();
    const subscriptions = [
      websocketService.subscribe(
        "agent_run_logs",
        (message: AgentRunLogsMessage) => {
          if (
            message.payload.runId === logId &&
            message.payload.channel !== "readable"
          ) {
            receivedOutput = true;
            pending.push(message.payload.logs);
            scheduleFlush();
          }
        },
      ),
      websocketService.subscribe(
        "agent_run_logs_error",
        (message: AgentRunLogsErrorMessage) => {
          if (message.payload.runId === logId) {
            flush();
            setError(message.payload.error);
            setIsStreaming(false);
            setHistoryLoaded(true);
          }
        },
      ),
      websocketService.subscribe(
        "agent_run_logs_ended",
        (message: AgentRunLogsEndedMessage) => {
          if (message.payload.runId === logId) {
            if (!receivedOutput && emptyRetryCount < EMPTY_LOG_RETRY_LIMIT) {
              emptyRetryCount += 1;
              setIsStreaming(true);
              emptyRetryTimer = setTimeout(
                subscribeToLogs,
                EMPTY_LOG_RETRY_DELAY_MS * emptyRetryCount,
              );
              return;
            }
            flush();
            setIsStreaming(false);
            setHistoryLoaded(true);
            if (message.payload.source) {
              setRetainedStatus({
                source: message.payload.source,
                truncated: message.payload.truncated ?? false,
              });
            }
          }
        },
      ),
    ];
    subscribeToLogs();
    return () => {
      if (emptyRetryTimer) clearTimeout(emptyRetryTimer);
      if (flushTimer) clearTimeout(flushTimer);
      for (const unsubscribe of subscriptions) unsubscribe();
      websocketService.send({
        type: "unsubscribe_agent_run_logs",
        payload: { runId: logId },
      });
    };
  }, [run.endedAt, logId, includeSessionHistory]);

  return (
    <DeploymentLogPanel
      title={title}
      content={terminalContent}
      contentRenderer={(output) => (
        <TerminalRecording key={run.taskId} content={output} />
      )}
      error={error}
      emptyIcon={run.endedAt && historyLoaded ? FileX2 : TerminalSquare}
      emptyMessage={
        !historyLoaded
          ? "Loading recording"
          : run.endedAt
            ? "No output recorded"
            : "Waiting for output"
      }
      emptyHint={
        !historyLoaded
          ? undefined
          : run.endedAt
            ? "This run ended without writing anything to its log."
            : "Output appears here as the Agent writes it."
      }
      status={
        isStreaming ? (
          <div
            aria-live="polite"
            className="flex items-center gap-1.5 font-mono text-xs text-emerald-400"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <span>Streaming</span>
          </div>
        ) : terminalContent ? (
          <RetainedTranscriptStatus status={retainedStatus} />
        ) : null
      }
    />
  );
}

const EMPTY_LOG_RETRY_LIMIT = 3;
const EMPTY_LOG_RETRY_DELAY_MS = 250;
const LIVE_FLUSH_MS = 100;
const HISTORY_IDLE_FLUSH_MS = 500;

function RetainedTranscriptStatus({
  status,
}: {
  status?: { source: "full" | "tail"; truncated: boolean };
}) {
  const isTailOnly = status?.source === "tail" && status.truncated;
  return (
    <div
      className={
        isTailOnly
          ? "flex items-center gap-1.5 font-mono text-xs text-amber-500"
          : "flex items-center gap-1.5 font-mono text-xs text-slate-500"
      }
      title={
        isTailOnly
          ? "The complete transcript exceeded this deployment's storage limit."
          : undefined
      }
    >
      <span
        className={
          isTailOnly
            ? "relative inline-flex h-2 w-2 rounded-full bg-amber-500"
            : "relative inline-flex h-2 w-2 rounded-full bg-slate-600"
        }
      />
      <span>
        {status?.source === "full"
          ? "Complete terminal recording"
          : isTailOnly
            ? "Retained tail only"
            : "Retained"}
      </span>
    </div>
  );
}
