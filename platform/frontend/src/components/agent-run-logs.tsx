"use client";

import type {
  AgentRunLogsEndedMessage,
  AgentRunLogsErrorMessage,
  AgentRunLogsMessage,
} from "@archestra/shared";
import { FileX2, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DeploymentLogPanel,
  useDeploymentLogAutoScroll,
} from "@/components/deployment-console";
import { TerminalPlayback } from "@/components/terminal-playback";
import type { AgentRun } from "@/lib/agent-runtime.query";
import websocketService from "@/lib/websocket/websocket";

export function AgentRunLogs({
  run,
  title = "Output",
}: {
  run: AgentRun;
  title?: string;
}) {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string>();
  const [isStreaming, setIsStreaming] = useState(!run.endedAt);
  const [retainedStatus, setRetainedStatus] = useState<{
    source: "full" | "tail";
    truncated: boolean;
  }>();
  const {
    scrollAreaRef,
    showScrollToBottom,
    scrollToBottom,
    followNewOutput,
    reset: resetAutoScroll,
  } = useDeploymentLogAutoScroll();

  useEffect(() => {
    setContent("");
    setError(undefined);
    setIsStreaming(!run.endedAt);
    setRetainedStatus(undefined);
    resetAutoScroll();
    websocketService.connect();
    const subscriptions = [
      websocketService.subscribe(
        "agent_run_logs",
        (message: AgentRunLogsMessage) => {
          if (message.payload.runId === run.taskId) {
            setContent((value) => value + message.payload.logs);
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
            setIsStreaming(false);
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
    websocketService.send({
      type: "subscribe_agent_run_logs",
      payload: { runId: run.taskId },
    });
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
      websocketService.send({
        type: "unsubscribe_agent_run_logs",
        payload: { runId: run.taskId },
      });
    };
  }, [run.endedAt, run.taskId, followNewOutput, resetAutoScroll]);

  return (
    <DeploymentLogPanel
      title={title}
      content={content}
      contentRenderer={(terminalContent) => (
        <TerminalPlayback content={terminalContent} />
      )}
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
          <RetainedTranscriptStatus status={retainedStatus} />
        ) : null
      }
    />
  );
}

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
          ? "Full transcript"
          : isTailOnly
            ? "Retained tail only"
            : "Retained"}
      </span>
    </div>
  );
}
