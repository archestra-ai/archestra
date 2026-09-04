"use client";

import type {
  AgentRunAttachClosedMessage,
  AgentRunAttachErrorMessage,
  AgentRunAttachOutputMessage,
  AgentRunAttachProgressMessage,
  AgentRunAttachStartedMessage,
} from "@archestra/shared";
import { useMemo } from "react";
import {
  type ExecSessionTransport,
  ExecTerminal,
} from "@/components/exec/exec-terminal";
import type { ExecSessionProgress } from "@/components/exec/exec-terminal-progress";
import { useMyAgentRun } from "@/lib/agent-runtime.query";
import websocketService from "@/lib/websocket/websocket";

/** Shared tmux terminal for Agent detail and Chat run sessions. */
export function AgentRunTerminal({
  taskId,
  active,
  title,
  showManualCommand,
  showDisconnectedStatus,
  onCommandChange,
  onError,
  onClosed,
}: {
  taskId: string;
  active: boolean;
  title?: string;
  showManualCommand?: boolean;
  showDisconnectedStatus?: boolean;
  onCommandChange?: (command: string | null) => void;
  onError?: () => void;
  onClosed?: () => void;
}) {
  const runQuery = useMyAgentRun(taskId, active);
  const run = runQuery.data?.taskId === taskId ? runQuery.data : null;
  const transport = useMemo<ExecSessionTransport>(
    () => createAgentRunTransport(taskId),
    [taskId],
  );

  return (
    <ExecTerminal
      sessionKey={taskId}
      transport={transport}
      // The metadata snapshot supplies both the original start time and the
      // current runtime phase. Opening the WebSocket first would briefly show
      // a fresh 0:00 counter on every reload before correcting itself.
      isActive={active && !!run}
      title={title}
      disconnectedLabel="Run finishing…"
      showManualCommand={showManualCommand}
      showDisconnectedStatus={showDisconnectedStatus}
      initialProgress={run?.startupProgress ?? DEFAULT_STARTUP_PROGRESS}
      progressStartedAt={parseStartedAt(run?.startedAt)}
      onCommandChange={onCommandChange}
      onError={onError}
      onClosed={onClosed}
    />
  );
}

export function createAgentRunTransport(taskId: string): ExecSessionTransport {
  return {
    open: (handlers) => {
      const subscriptions = [
        websocketService.subscribe(
          "agent_run_attach_started",
          (message: AgentRunAttachStartedMessage) => {
            if (message.payload.runId === taskId) {
              handlers.onStarted(message.payload.command);
            }
          },
        ),
        websocketService.subscribe(
          "agent_run_attach_progress",
          (message: AgentRunAttachProgressMessage) => {
            if (message.payload.runId === taskId) {
              handlers.onProgress?.({
                phase: message.payload.phase,
                message: message.payload.message,
                detail: message.payload.detail ?? null,
                resourceName: message.payload.resourceName ?? null,
              });
            }
          },
        ),
        websocketService.subscribe(
          "agent_run_attach_output",
          (message: AgentRunAttachOutputMessage) => {
            if (message.payload.runId === taskId) {
              handlers.onOutput(message.payload.data);
            }
          },
        ),
        websocketService.subscribe(
          "agent_run_attach_error",
          (message: AgentRunAttachErrorMessage) => {
            if (message.payload.runId === taskId) {
              handlers.onError(message.payload.error);
            }
          },
        ),
        websocketService.subscribe(
          "agent_run_attach_closed",
          (message: AgentRunAttachClosedMessage) => {
            if (message.payload.runId === taskId) {
              handlers.onClosed(message.payload.reason ?? null);
            }
          },
        ),
      ];
      const openSession = () =>
        websocketService.send({
          type: "subscribe_agent_run_attach",
          payload: { runId: taskId },
        });
      const unsubscribeConnection = websocketService.onConnectionChange(
        (connected) => {
          if (connected) openSession();
        },
      );
      if (websocketService.isConnected()) {
        openSession();
      } else {
        void websocketService.connect();
      }
      return () => {
        unsubscribeConnection();
        for (const unsubscribe of subscriptions) unsubscribe();
        websocketService.send({
          type: "unsubscribe_agent_run_attach",
          payload: { runId: taskId },
        });
      };
    },
    sendInput: (data) =>
      websocketService.send({
        type: "agent_run_attach_input",
        payload: { runId: taskId, data },
      }),
    sendResize: (cols, rows) =>
      websocketService.send({
        type: "agent_run_attach_resize",
        payload: { runId: taskId, cols, rows },
      }),
  };
}

// ===================== internals =====================

const DEFAULT_STARTUP_PROGRESS: ExecSessionProgress = {
  phase: "queued",
  message: "Preparing the run environment",
  detail: null,
  resourceName: null,
};

function parseStartedAt(startedAt: string | undefined): number | undefined {
  if (!startedAt) return undefined;
  const parsed = new Date(startedAt).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}
