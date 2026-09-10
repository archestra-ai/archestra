"use client";

import type {
  AgentRunLogsEndedMessage,
  AgentRunLogsErrorMessage,
  AgentRunLogsMessage,
} from "@archestra/shared";
import { FileX2, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatAgentRunReadableTranscript } from "@/components/agent-run-readable-transcript";
import { DeploymentLogPanel } from "@/components/deployment-console";
import { TerminalRecording } from "@/components/terminal-recording";
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
  const readableTranscript = useMemo(
    () => formatAgentRunReadableTranscript(readableContent),
    [readableContent],
  );
  const hasReadableTranscript = !!readableTranscript;
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
    setView("terminal");
    setError(undefined);
    setIsStreaming(!run.endedAt);
    setRetainedStatus(undefined);
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
  }, [run.endedAt, run.taskId]);

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
              <TabsTrigger value="readable">Readable transcript</TabsTrigger>
              <TabsTrigger value="terminal">Terminal recording</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : undefined
      }
      content={showReadable ? readableTranscript : terminalContent}
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
