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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  const [view, setView] = useState<"readable" | "terminal">("readable");
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
  const hasReadableTranscript = !!conversation;
  const showReadable = hasReadableTranscript && view === "readable";
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
    setView("readable");
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

  if (showReadable && conversation)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">
            {title === "Live terminal" ? "Conversation" : title}
          </span>
          <Tabs value="readable" onValueChange={() => setView("terminal")}>
            <TabsList aria-label="Output view">
              <TabsTrigger value="readable">Conversation</TabsTrigger>
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <AgentRunConversation
          key={run.taskId}
          transcript={conversation}
          taskId={run.taskId}
          canControl={canControl && !run.endedAt && !!conversation.session}
        />
      </div>
    );

  if (liveTerminal)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {conversation && (
          <Tabs value="terminal" onValueChange={() => setView("readable")}>
            <TabsList>
              <TabsTrigger value="readable">Conversation</TabsTrigger>
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {liveTerminal}
      </div>
    );

  return (
    <DeploymentLogPanel
      className="min-w-0"
      title={title}
      actions={
        hasReadableTranscript ? (
          <Tabs
            value={showReadable ? "readable" : "terminal"}
            onValueChange={(value) =>
              setView(value === "readable" ? "readable" : "terminal")
            }
          >
            <TabsList aria-label="Output view">
              <TabsTrigger value="readable">Conversation</TabsTrigger>
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : undefined
      }
      content={terminalContent}
      contentRenderer={
        showReadable
          ? undefined
          : (output) => <TerminalRecording key={run.taskId} content={output} />
      }
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
        ) : showReadable ? (
          <span className="font-mono text-xs text-slate-500">
            Readable transcript
          </span>
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
