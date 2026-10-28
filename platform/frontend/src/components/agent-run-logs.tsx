"use client";

import type {
  AgentRunLogsEndedMessage,
  AgentRunLogsErrorMessage,
  AgentRunLogsMessage,
} from "@archestra/shared";
import { Download, FileX2, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DeploymentLogPanel } from "@/components/deployment-console";
import { TerminalRecording } from "@/components/terminal-recording";
import { Button } from "@/components/ui/button";
import type { AgentRun } from "@/lib/agent-runtime.query";
import { formatBytes } from "@/lib/utils/format-bytes";
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
  const [readableContent, setReadableContent] = useState("");
  const [pendingDownload, setPendingDownload] = useState<
    "logs" | "trajectory" | null
  >(null);
  const [isStreaming, setIsStreaming] = useState(!run.endedAt);
  // An ended run's history is on its way until the server says it has ended:
  // until then the panel is loading, not empty.
  const [historyLoaded, setHistoryLoaded] = useState(!run.endedAt);
  const [retainedStatus, setRetainedStatus] = useState<{
    source: "full" | "tail";
    truncated: boolean;
  }>();
  // An ended run opens on the end of its recording: replaying a long one in
  // full costs seconds of main thread and, for the longest, the tab. The rest
  // loads on request.
  const [fullRecording, setFullRecording] = useState(false);
  const [omittedBytes, setOmittedBytes] = useState(0);
  const requestTail = Boolean(run.endedAt) && !fullRecording;

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
    let readable = "";
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
          ...(requestTail ? { tailBytes: RECORDING_TAIL_BYTES } : {}),
        },
      });
    };
    setTerminalContent("");
    setReadableContent("");
    setError(undefined);
    setIsStreaming(!run.endedAt);
    setHistoryLoaded(!run.endedAt);
    setOmittedBytes(0);
    setRetainedStatus(undefined);
    websocketService.connect();
    const subscriptions = [
      websocketService.subscribe(
        "agent_run_logs",
        (message: AgentRunLogsMessage) => {
          if (message.payload.runId !== logId) return;
          if (message.payload.channel === "readable") {
            readable += message.payload.logs;
          } else {
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
            // Retained output can land after the run's metadata, so an empty
            // end is retried; not when the server says what it left out.
            if (
              !receivedOutput &&
              !readable &&
              !message.payload.omittedBytes &&
              emptyRetryCount < EMPTY_LOG_RETRY_LIMIT
            ) {
              emptyRetryCount += 1;
              setIsStreaming(true);
              emptyRetryTimer = setTimeout(
                subscribeToLogs,
                EMPTY_LOG_RETRY_DELAY_MS * emptyRetryCount,
              );
              return;
            }
            flush();
            setReadableContent(readable);
            setIsStreaming(false);
            setHistoryLoaded(true);
            setOmittedBytes(message.payload.omittedBytes ?? 0);
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
  }, [run.endedAt, logId, includeSessionHistory, requestTail]);

  useEffect(() => {
    if (
      !pendingDownload ||
      !historyLoaded ||
      isStreaming ||
      omittedBytes > 0 ||
      requestTail
    )
      return;
    setPendingDownload(null);
    if (error) return;
    if (pendingDownload === "logs" && terminalContent) {
      downloadRunOutput(run.taskId, terminalContent, "log", "text/plain");
    } else if (pendingDownload === "trajectory") {
      if (readableContent)
        downloadRunOutput(
          run.taskId,
          readableContent,
          "json",
          "application/json",
        );
      else
        toast.info(
          "No native trajectory was recorded for this run. Its retained terminal output is available in Download logs.",
        );
    }
  }, [
    pendingDownload,
    historyLoaded,
    isStreaming,
    omittedBytes,
    requestTail,
    error,
    terminalContent,
    readableContent,
    run.taskId,
  ]);

  return (
    <DeploymentLogPanel
      title={title}
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={
              !terminalContent || Boolean(error) || Boolean(pendingDownload)
            }
            title={
              omittedBytes > 0
                ? "Loads the full retained recording before downloading"
                : "Download retained terminal output; live runs include output received so far"
            }
            onClick={() => {
              if (omittedBytes > 0) {
                setPendingDownload("logs");
                setFullRecording(true);
              } else {
                downloadRunOutput(
                  run.taskId,
                  terminalContent,
                  "log",
                  "text/plain",
                );
              }
            }}
          >
            <Download className="size-4" />
            <span>
              {pendingDownload === "logs" ? "Loading logs…" : "Download logs"}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={
              !run.endedAt ||
              !historyLoaded ||
              Boolean(error) ||
              Boolean(pendingDownload)
            }
            title={
              readableContent
                ? "Download the retained native trajectory as JSON"
                : "Available when native history has been collected after the run ends; load the full recording if only its end is shown"
            }
            onClick={() => {
              if (readableContent)
                downloadRunOutput(
                  run.taskId,
                  readableContent,
                  "json",
                  "application/json",
                );
              else if (requestTail) {
                setPendingDownload("trajectory");
                setHistoryLoaded(false);
                setFullRecording(true);
              } else
                toast.info(
                  "No native trajectory was recorded for this run. Its retained terminal output is available in Download logs.",
                );
            }}
          >
            <Download className="size-4" />
            <span>
              {pendingDownload === "trajectory"
                ? "Loading trajectory…"
                : "Download trajectory"}
            </span>
          </Button>
        </div>
      }
      content={terminalContent}
      contentRenderer={(output) => (
        <TerminalRecording
          key={`${run.taskId}:${fullRecording}`}
          content={output}
        />
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
        ) : terminalContent || omittedBytes > 0 ? (
          <div className="flex items-center gap-3">
            {omittedBytes > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 font-mono text-xs text-slate-300"
                onClick={() => setFullRecording(true)}
              >
                Load full recording ({formatBytes(omittedBytes)} more)
              </Button>
            )}
            {terminalContent && (
              <RetainedTranscriptStatus
                status={retainedStatus}
                partial={omittedBytes > 0}
              />
            )}
          </div>
        ) : null
      }
    />
  );
}

const EMPTY_LOG_RETRY_LIMIT = 3;
const EMPTY_LOG_RETRY_DELAY_MS = 250;
const LIVE_FLUSH_MS = 100;
/** How much of an ended run's recording opens first. */
const RECORDING_TAIL_BYTES = 2 * 1024 * 1024;
const HISTORY_IDLE_FLUSH_MS = 500;

function RetainedTranscriptStatus({
  status,
  partial = false,
}: {
  status?: { source: "full" | "tail"; truncated: boolean };
  /** Only the end of the recording is shown; the rest loads on request. */
  partial?: boolean;
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
          ? partial
            ? "End of the recording"
            : "Complete terminal recording"
          : isTailOnly
            ? "Retained tail only"
            : "Retained"}
      </span>
    </div>
  );
}

/** Export recorded bytes without copying the rendered terminal's viewport. */
function downloadRunOutput(
  taskId: string,
  content: string,
  extension: string,
  type: string,
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `agent-run-${taskId}.${extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
