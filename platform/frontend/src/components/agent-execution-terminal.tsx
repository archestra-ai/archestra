"use client";

import type {
  AgentRunAttachClosedMessage,
  AgentRunAttachErrorMessage,
  AgentRunAttachOutputMessage,
  AgentRunAttachStartedMessage,
} from "@archestra/shared";
import { useMemo } from "react";
import {
  type ExecSessionTransport,
  ExecTerminal,
} from "@/components/exec/exec-terminal";
import websocketService from "@/lib/websocket/websocket";

/** Shared tmux terminal for Agent detail and Chat execution sessions. */
export function AgentExecutionTerminal({
  taskId,
  active,
  title,
  onClosed,
}: {
  taskId: string;
  active: boolean;
  title?: string;
  onClosed?: () => void;
}) {
  const transport = useMemo<ExecSessionTransport>(
    () => createAgentExecutionTransport(taskId),
    [taskId],
  );

  return (
    <ExecTerminal
      sessionKey={taskId}
      transport={transport}
      isActive={active}
      title={title}
      disconnectedLabel="Execution finishing…"
      onClosed={onClosed}
    />
  );
}

export function createAgentExecutionTransport(
  taskId: string,
): ExecSessionTransport {
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
