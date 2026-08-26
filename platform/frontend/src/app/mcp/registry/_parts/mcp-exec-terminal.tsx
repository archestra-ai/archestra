"use client";

import type {
  McpExecClosedMessage,
  McpExecErrorMessage,
  McpExecOutputMessage,
  McpExecStartedMessage,
} from "@archestra/shared";
import { useMemo } from "react";
import {
  type ExecSessionTransport,
  ExecTerminal,
} from "@/components/exec/exec-terminal";
import websocketService from "@/lib/websocket/websocket";

interface McpExecTerminalProps {
  serverId: string;
  isActive: boolean;
}

/**
 * A debug shell into an MCP server's pod. The terminal itself is shared with
 * Runners; only the WebSocket conversation differs, so that is all this file
 * carries.
 */
export function McpExecTerminal({ serverId, isActive }: McpExecTerminalProps) {
  const transport = useMemo<ExecSessionTransport>(
    () => ({
      open: (handlers) => {
        websocketService.connect();

        const unsubscribes = [
          websocketService.subscribe(
            "mcp_exec_started",
            (message: McpExecStartedMessage) => {
              if (message.payload.serverId !== serverId) return;
              handlers.onStarted(message.payload.command);
            },
          ),
          websocketService.subscribe(
            "mcp_exec_output",
            (message: McpExecOutputMessage) => {
              if (message.payload.serverId !== serverId) return;
              handlers.onOutput(message.payload.data);
            },
          ),
          websocketService.subscribe(
            "mcp_exec_error",
            (message: McpExecErrorMessage) => {
              if (message.payload.serverId !== serverId) return;
              handlers.onError(message.payload.error);
            },
          ),
          websocketService.subscribe(
            "mcp_exec_closed",
            (message: McpExecClosedMessage) => {
              if (message.payload.serverId !== serverId) return;
              handlers.onClosed(message.payload.reason ?? null);
            },
          ),
        ];

        websocketService.send({
          type: "subscribe_mcp_exec",
          payload: { serverId },
        });

        return () => {
          for (const unsubscribe of unsubscribes) unsubscribe();
          websocketService.send({
            type: "unsubscribe_mcp_exec",
            payload: { serverId },
          });
        };
      },
      sendInput: (data) => {
        websocketService.send({
          type: "mcp_exec_input",
          payload: { serverId, data },
        });
      },
      sendResize: (cols, rows) => {
        websocketService.send({
          type: "mcp_exec_resize",
          payload: { serverId, cols, rows },
        });
      },
    }),
    [serverId],
  );

  return (
    <ExecTerminal
      sessionKey={serverId}
      transport={transport}
      isActive={isActive}
    />
  );
}
