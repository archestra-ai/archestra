"use client";

import type {
  AgentRunLogsEndedMessage,
  AgentRunLogsErrorMessage,
  AgentRunLogsMessage,
} from "@archestra/shared";
import { useEffect, useState } from "react";
import {
  DeploymentLogPanel,
  useDeploymentLogAutoScroll,
} from "@/components/deployment-console";
import { plainTerminalTranscript } from "@/components/terminal-transcript";
import type { AgentExecution } from "@/lib/agent-background-execution.query";
import websocketService from "@/lib/websocket/websocket";

export function AgentExecutionLogs({
  execution,
  title = "Output",
}: {
  execution: AgentExecution;
  title?: string;
}) {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string>();
  const [isStreaming, setIsStreaming] = useState(!execution.endedAt);
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
    setIsStreaming(!execution.endedAt);
    resetAutoScroll();
    websocketService.connect();
    const subscriptions = [
      websocketService.subscribe(
        "agent_run_logs",
        (message: AgentRunLogsMessage) => {
          if (message.payload.runId === execution.taskId) {
            setContent((value) => value + message.payload.logs);
            followNewOutput();
          }
        },
      ),
      websocketService.subscribe(
        "agent_run_logs_error",
        (message: AgentRunLogsErrorMessage) => {
          if (message.payload.runId === execution.taskId) {
            setError(message.payload.error);
            setIsStreaming(false);
          }
        },
      ),
      websocketService.subscribe(
        "agent_run_logs_ended",
        (message: AgentRunLogsEndedMessage) => {
          if (message.payload.runId === execution.taskId) {
            setIsStreaming(false);
          }
        },
      ),
    ];
    websocketService.send({
      type: "subscribe_agent_run_logs",
      payload: { runId: execution.taskId },
    });
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
      websocketService.send({
        type: "unsubscribe_agent_run_logs",
        payload: { runId: execution.taskId },
      });
    };
  }, [execution.endedAt, execution.taskId, followNewOutput, resetAutoScroll]);

  return (
    <DeploymentLogPanel
      title={title}
      content={plainTerminalTranscript(content)}
      error={error}
      scrollAreaRef={scrollAreaRef}
      showScrollToBottom={showScrollToBottom}
      onScrollToBottom={scrollToBottom}
      emptyMessage={
        execution.endedAt
          ? "No output was recorded for this execution."
          : "Waiting for output…"
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
            Streaming
          </div>
        ) : content ? (
          <div className="flex items-center gap-1.5 font-mono text-xs text-slate-500">
            <span className="relative inline-flex h-2 w-2 rounded-full bg-slate-600" />
            Retained
          </div>
        ) : null
      }
    />
  );
}
