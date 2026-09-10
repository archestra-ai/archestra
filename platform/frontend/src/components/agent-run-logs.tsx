"use client";

import {
  type AgentRunLogsEndedMessage,
  type AgentRunLogsErrorMessage,
  type AgentRunLogsMessage,
  type AgentRunReadableTranscript,
  AgentRunReadableTranscriptSchema,
} from "@archestra/shared";
import { FileX2, TerminalSquare } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AgentRunConversation } from "@/components/agent-run-conversation";
import { DeploymentLogPanel } from "@/components/deployment-console";
import { TerminalRecording } from "@/components/terminal-recording";

import type { AgentRun } from "@/lib/agent-runtime.query";
import websocketService from "@/lib/websocket/websocket";

export function AgentRunLogs({
  run,
  title = "Output",
  liveTerminal,
  canControl = false,
}: {
  run: AgentRun;
  title?: string;
  liveTerminal?: ReactNode;
  canControl?: boolean;
}) {
  const [terminalContent, setTerminalContent] = useState("");
  const [readableContent, setReadableContent] = useState("");

  const [snapshot, setSnapshot] = useState<AgentRunReadableTranscript | null>(
    null,
  );
  const savedSnapshot = useMemo(() => {
    try {
      const parsed = AgentRunReadableTranscriptSchema.safeParse(
        JSON.parse(readableContent),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }, [readableContent]);
  const conversation = useMemo(() => {
    const value = snapshot ?? savedSnapshot;
    if (
      run.endedAt &&
      value?.session &&
      ["starting", "working", "input_required"].includes(value.session.state)
    ) {
      return { ...value, session: { state: "stopped" as const, requests: [] } };
    }
    return value;
  }, [snapshot, savedSnapshot, run.endedAt]);

  const [error, setError] = useState<string>();
  const [isStreaming, setIsStreaming] = useState(!run.endedAt);
  const [retainedStatus, setRetainedStatus] = useState<{
    source: "full" | "tail";
    truncated: boolean;
  }>();

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
    setSnapshot(null);
    setError(undefined);
    setIsStreaming(!run.endedAt);
    setRetainedStatus(undefined);
    websocketService.connect();
    const subscriptions = [
      websocketService.subscribe("agent_run_session", (message) => {
        if (message.payload.runId !== run.taskId) return;
        receivedOutput = true;
        setSnapshot(message.payload.transcript);
      }),
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
            // A dropped exec/log stream does not end the running agent or the WebSocket.
            if (!run.endedAt) {
              if (emptyRetryTimer) clearTimeout(emptyRetryTimer);
              emptyRetryTimer = setTimeout(() => {
                setTerminalContent("");
                setReadableContent("");
                subscribeToLogs();
              }, 1000);
              return;
            }
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
          }
        },
      ),
    ];
    const unsubscribeConnection = websocketService.onConnectionChange(
      (connected) => {
        if (!connected) return;
        // Reconnection replays an authoritative snapshot; terminal chunks restart too.
        setTerminalContent("");
        setReadableContent("");
        receivedOutput = false;
        subscribeToLogs();
      },
    );
    if (websocketService.isConnected()) subscribeToLogs();
    return () => {
      unsubscribeConnection();
      if (emptyRetryTimer) clearTimeout(emptyRetryTimer);
      for (const unsubscribe of subscriptions) unsubscribe();
      websocketService.send({
        type: "unsubscribe_agent_run_logs",
        payload: { runId: run.taskId },
      });
    };
  }, [run.endedAt, run.taskId]);

  if (conversation)
    return (
      <AgentRunConversation
        key={run.taskId}
        transcript={conversation}
        taskId={run.taskId}
        agentId={run.agentId}
        agentName="Agent"
        canControl={canControl && !run.endedAt && !!conversation.session}
      />
    );
  if (liveTerminal) return liveTerminal;

  return (
    <DeploymentLogPanel
      className="min-w-0"
      title={title}
      content={terminalContent}
      contentRenderer={(output) => (
        <TerminalRecording key={run.taskId} content={output} />
      )}
      error={error}
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
        ) : terminalContent ? (
          <RetainedTranscriptStatus status={retainedStatus} />
        ) : null
      }
    />
  );
}

const EMPTY_LOG_RETRY_LIMIT = 3;
const EMPTY_LOG_RETRY_DELAY_MS = 250;

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
