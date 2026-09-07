"use client";

import type {
  AgentRunLogsEndedMessage,
  AgentRunLogsErrorMessage,
  AgentRunLogsMessage,
} from "@archestra/shared";
import { FileX2, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatAgentRunReadableTranscript } from "@/components/agent-run-readable-transcript";
import {
  DeploymentLogPanel,
  useDeploymentLogAutoScroll,
} from "@/components/deployment-console";
import { TerminalPlayback } from "@/components/terminal-playback";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AgentRun } from "@/lib/agent-runtime.query";
import websocketService from "@/lib/websocket/websocket";

export function AgentRunLogs({
  run,
  title = "Output",
}: {
  run: AgentRun;
  title?: string;
}) {
  const [terminalContent, setTerminalContent] = useState("");
  const [readableContent, setReadableContent] = useState("");
  const [view, setView] = useState<"readable" | "terminal">("terminal");
  const [error, setError] = useState<string>();
  const [isStreaming, setIsStreaming] = useState(!run.endedAt);
  const [retainedStatus, setRetainedStatus] = useState<{
    source: "full" | "tail";
    truncated: boolean;
  }>();
  const [readableStatus, setReadableStatus] = useState<{
    provider: string;
    version: number;
    totalBytes: number;
  }>();
  const formattedReadableContent = useMemo(
    () =>
      readableContent
        ? formatAgentRunReadableTranscript(readableContent)
        : null,
    [readableContent],
  );
  const hasReadableTranscript =
    !!readableStatus && formattedReadableContent !== null;
  const content =
    view === "readable" && hasReadableTranscript
      ? formattedReadableContent
      : terminalContent;
  const {
    scrollAreaRef,
    showScrollToBottom,
    scrollToBottom,
    followNewOutput,
    reset: resetAutoScroll,
  } = useDeploymentLogAutoScroll();

  useEffect(() => {
    let receivedOutput = false;
    let emptyRetryCount = 0;
    let emptyRetryTimer: ReturnType<typeof setTimeout> | undefined;
    const subscribeToLogs = () => {
      websocketService.send({
        type: "subscribe_agent_run_logs",
        payload: { runId: run.taskId },
      });
    };
    setTerminalContent("");
    setReadableContent("");
    setView("terminal");
    setError(undefined);
    setIsStreaming(!run.endedAt);
    setRetainedStatus(undefined);
    setReadableStatus(undefined);
    resetAutoScroll();
    websocketService.connect();
    const subscriptions = [
      websocketService.subscribe(
        "agent_run_logs",
        (message: AgentRunLogsMessage) => {
          if (message.payload.runId === run.taskId) {
            receivedOutput = true;
            if (message.payload.channel === "readable") {
              setReadableContent((value) => value + message.payload.logs);
            } else {
              setTerminalContent((value) => value + message.payload.logs);
            }
            followNewOutput();
          }
        },
      ),
      websocketService.subscribe(
        "agent_run_logs_error",
        (message: AgentRunLogsErrorMessage) => {
          if (message.payload.runId === run.taskId) {
            setError(message.payload.error);
            setIsStreaming(false);
          }
        },
      ),
      websocketService.subscribe(
        "agent_run_logs_ended",
        (message: AgentRunLogsEndedMessage) => {
          if (message.payload.runId === run.taskId) {
            if (!receivedOutput && emptyRetryCount < EMPTY_LOG_RETRY_LIMIT) {
              emptyRetryCount += 1;
              setIsStreaming(true);
              emptyRetryTimer = setTimeout(
                subscribeToLogs,
                EMPTY_LOG_RETRY_DELAY_MS * emptyRetryCount,
              );
              return;
            }
            setIsStreaming(false);
            if (message.payload.source) {
              setRetainedStatus({
                source: message.payload.source,
                truncated: message.payload.truncated ?? false,
              });
            }
            if (message.payload.readable) {
              setReadableStatus(message.payload.readable);
              setView("readable");
            }
          }
        },
      ),
    ];
    subscribeToLogs();
    return () => {
      if (emptyRetryTimer) clearTimeout(emptyRetryTimer);
      for (const unsubscribe of subscriptions) unsubscribe();
      websocketService.send({
        type: "unsubscribe_agent_run_logs",
        payload: { runId: run.taskId },
      });
    };
  }, [run.endedAt, run.taskId, followNewOutput, resetAutoScroll]);

  return (
    <Tabs
      value={view}
      onValueChange={(value) => setView(value as "readable" | "terminal")}
      className="min-h-0 flex-1"
    >
      <DeploymentLogPanel
        title={title}
        content={content}
        contentRenderer={
          view === "terminal"
            ? (terminalOutput) => <TerminalPlayback content={terminalOutput} />
            : undefined
        }
        error={error}
        scrollAreaRef={scrollAreaRef}
        showScrollToBottom={showScrollToBottom}
        onScrollToBottom={scrollToBottom}
        emptyIcon={run.endedAt ? FileX2 : TerminalSquare}
        emptyMessage={run.endedAt ? "No output recorded" : "Waiting for output"}
        emptyHint={
          run.endedAt
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
          ) : content ? (
            <RetainedTranscriptStatus status={retainedStatus} view={view} />
          ) : null
        }
        actions={
          hasReadableTranscript ? (
            <TabsList className="h-7 rounded-md bg-muted/60 p-0.5">
              <TabsTrigger
                value="readable"
                className="h-6 rounded-[5px] px-2 text-xs"
              >
                Readable transcript
              </TabsTrigger>
              <TabsTrigger
                value="terminal"
                className="h-6 rounded-[5px] px-2 text-xs"
              >
                Terminal replay
              </TabsTrigger>
            </TabsList>
          ) : undefined
        }
      />
    </Tabs>
  );
}

const EMPTY_LOG_RETRY_LIMIT = 3;
const EMPTY_LOG_RETRY_DELAY_MS = 250;

function RetainedTranscriptStatus({
  status,
  view,
}: {
  status?: { source: "full" | "tail"; truncated: boolean };
  view: "readable" | "terminal";
}) {
  if (view === "readable") {
    return (
      <div className="flex items-center gap-1.5 font-mono text-xs text-slate-500">
        <span className="relative inline-flex h-2 w-2 rounded-full bg-slate-600" />
        <span>Readable transcript</span>
      </div>
    );
  }
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
