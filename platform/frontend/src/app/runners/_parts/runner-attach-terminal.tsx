"use client";

import type {
  RunnerAttachClosedMessage,
  RunnerAttachErrorMessage,
  RunnerAttachOutputMessage,
  RunnerAttachStartedMessage,
} from "@archestra/shared";
import { useMemo } from "react";
import {
  type ExecSessionTransport,
  ExecTerminal,
} from "@/components/exec/exec-terminal";
import websocketService from "@/lib/websocket/websocket";

interface RunnerAttachTerminalProps {
  runnerId: string;
  isActive: boolean;
}

/**
 * A live view into the agent's own tmux session: the same pane it is working
 * in, so typing here interjects rather than opening a second shell beside it.
 * Closing the tab detaches; the session keeps running.
 */
export function RunnerAttachTerminal({
  runnerId,
  isActive,
}: RunnerAttachTerminalProps) {
  const transport = useMemo<ExecSessionTransport>(
    () => ({
      open: (handlers) => {
        websocketService.connect();

        const unsubscribes = [
          websocketService.subscribe(
            "runner_attach_started",
            (message: RunnerAttachStartedMessage) => {
              if (message.payload.runnerId !== runnerId) return;
              handlers.onStarted(message.payload.command);
            },
          ),
          websocketService.subscribe(
            "runner_attach_output",
            (message: RunnerAttachOutputMessage) => {
              if (message.payload.runnerId !== runnerId) return;
              handlers.onOutput(message.payload.data);
            },
          ),
          websocketService.subscribe(
            "runner_attach_error",
            (message: RunnerAttachErrorMessage) => {
              if (message.payload.runnerId !== runnerId) return;
              handlers.onError(message.payload.error);
            },
          ),
          websocketService.subscribe(
            "runner_attach_closed",
            (message: RunnerAttachClosedMessage) => {
              if (message.payload.runnerId !== runnerId) return;
              handlers.onClosed(message.payload.reason ?? null);
            },
          ),
        ];

        const openSession = () => {
          websocketService.send({
            type: "subscribe_runner_attach",
            payload: { runnerId },
          });
        };

        // The server drops every subscription with the socket it was made on,
        // so a reconnect has to re-open the session rather than leave a
        // terminal that looks live and receives nothing.
        const unsubscribeConnection = websocketService.onConnectionChange(
          (connected) => {
            if (connected) openSession();
          },
        );
        openSession();

        return () => {
          unsubscribeConnection();
          for (const unsubscribe of unsubscribes) unsubscribe();
          websocketService.send({
            type: "unsubscribe_runner_attach",
            payload: { runnerId },
          });
        };
      },
      sendInput: (data) => {
        websocketService.send({
          type: "runner_attach_input",
          payload: { runnerId, data },
        });
      },
      sendResize: (cols, rows) => {
        websocketService.send({
          type: "runner_attach_resize",
          payload: { runnerId, cols, rows },
        });
      },
    }),
    [runnerId],
  );

  return (
    <ExecTerminal
      sessionKey={runnerId}
      transport={transport}
      isActive={isActive}
      title="Live Session"
      manualCommandTitle="Attach From Your Terminal"
    />
  );
}
