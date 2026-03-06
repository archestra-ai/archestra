"use client";

import type {
  McpExecClosedMessage,
  McpExecErrorMessage,
  McpExecOutputMessage,
  McpExecStartedMessage,
} from "@shared";
import { Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import websocketService from "@/lib/websocket";

type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

interface McpExecTerminalProps {
  serverId: string;
  isActive: boolean;
}

export function McpExecTerminal({ serverId, isActive }: McpExecTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<import("@xterm/xterm").Terminal | null>(
    null,
  );
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const initializedRef = useRef(false);

  const cleanup = useCallback(() => {
    if (terminalInstanceRef.current) {
      terminalInstanceRef.current.dispose();
      terminalInstanceRef.current = null;
    }
    fitAddonRef.current = null;
    initializedRef.current = false;
  }, []);

  useEffect(() => {
    if (!isActive || !terminalRef.current || initializedRef.current) return;

    let disposed = false;

    const init = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      // Dynamically import the CSS
      // @ts-expect-error -- CSS module import handled by Next.js bundler
      await import("@xterm/xterm/css/xterm.css");

      if (disposed || !terminalRef.current) return;

      const fitAddon = new FitAddon();
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        theme: {
          background: "#0f172a", // slate-950
          foreground: "#34d399", // emerald-400 — matches logs
          cursor: "#34d399",
        },
      });

      terminal.loadAddon(fitAddon);
      terminal.open(terminalRef.current);

      // Fit after a short delay to ensure container is measured
      requestAnimationFrame(() => {
        if (!disposed) {
          try {
            fitAddon.fit();
          } catch {
            // Container may not be visible yet
          }
        }
      });

      terminalInstanceRef.current = terminal;
      fitAddonRef.current = fitAddon;
      initializedRef.current = true;

      // Connect and subscribe via shared WebSocket
      setStatus("connecting");
      setErrorMessage(null);

      websocketService.connect();

      const unsubStarted = websocketService.subscribe(
        "mcp_exec_started",
        (message: McpExecStartedMessage) => {
          if (message.payload.serverId !== serverId || disposed) return;
          setStatus("connected");
          setCommand(message.payload.command);

          // Send initial resize
          const dims = fitAddon.proposeDimensions();
          if (dims?.cols != null && dims?.rows != null) {
            websocketService.send({
              type: "mcp_exec_resize",
              payload: { serverId, cols: dims.cols, rows: dims.rows },
            });
          }
        },
      );

      const unsubOutput = websocketService.subscribe(
        "mcp_exec_output",
        (message: McpExecOutputMessage) => {
          if (message.payload.serverId !== serverId || disposed) return;
          terminal.write(message.payload.data);
        },
      );

      const unsubError = websocketService.subscribe(
        "mcp_exec_error",
        (message: McpExecErrorMessage) => {
          if (message.payload.serverId !== serverId || disposed) return;
          setStatus("error");
          setErrorMessage(message.payload.error);
        },
      );

      const unsubClosed = websocketService.subscribe(
        "mcp_exec_closed",
        (message: McpExecClosedMessage) => {
          if (message.payload.serverId !== serverId || disposed) return;
          setStatus("disconnected");
        },
      );

      // Terminal input -> WS
      terminal.onData((data) => {
        websocketService.send({
          type: "mcp_exec_input",
          payload: { serverId, data },
        });
      });

      // Send subscribe to start the exec session
      websocketService.send({
        type: "subscribe_mcp_exec",
        payload: { serverId },
      });

      // Resize observer
      const resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        try {
          fitAddon.fit();
          const dims = fitAddon.proposeDimensions();
          if (dims?.cols != null && dims?.rows != null) {
            websocketService.send({
              type: "mcp_exec_resize",
              payload: { serverId, cols: dims.cols, rows: dims.rows },
            });
          }
        } catch {
          // Ignore fit errors during transitions
        }
      });

      if (terminalRef.current) {
        resizeObserver.observe(terminalRef.current);
      }

      return () => {
        resizeObserver.disconnect();
        unsubStarted();
        unsubOutput();
        unsubError();
        unsubClosed();
      };
    };

    const cleanupPromise = init();

    return () => {
      disposed = true;
      cleanupPromise?.then((cleanupFn) => cleanupFn?.());
      // Unsubscribe exec session on the server
      websocketService.send({
        type: "unsubscribe_mcp_exec",
        payload: { serverId },
      });
      cleanup();
    };
  }, [isActive, serverId, cleanup]);

  const statusText = {
    idle: "",
    connecting: "Connecting...",
    connected: "",
    disconnected: "Session terminated",
    error: errorMessage || "Connection error",
  }[status];

  const [commandCopied, setCommandCopied] = useState(false);

  const handleCopyCommand = useCallback(async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCommandCopied(true);
      toast.success("Command copied to clipboard");
      setTimeout(() => setCommandCopied(false), 2000);
    } catch {
      toast.error("Failed to copy command");
    }
  }, [command]);

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex flex-col gap-2 flex-1 min-h-0">
        <h3 className="text-sm font-semibold flex-shrink-0">
          Interactive Shell
        </h3>
        <div className="flex flex-col flex-1 min-h-0 rounded-md border bg-slate-950 overflow-hidden">
          {status === "connecting" && (
            <div className="flex items-center justify-center p-4 text-slate-400 text-sm font-mono">
              {statusText}
            </div>
          )}
          {(status === "error" || status === "disconnected") && (
            <div
              className={`flex items-center justify-center p-4 text-sm font-mono ${status === "error" ? "text-red-400" : "text-yellow-400"}`}
            >
              {statusText}
            </div>
          )}
          <div
            ref={terminalRef}
            className="flex-1 min-h-0"
            style={{ display: status === "connecting" ? "none" : "block" }}
          />
          {status === "connected" && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-slate-800">
              <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-mono">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                Connected
              </div>
              <div />
            </div>
          )}
        </div>
      </div>

      {command && (
        <div className="flex flex-col gap-2 flex-shrink-0">
          <h3 className="text-sm font-semibold">Manual Command</h3>
          <div className="relative">
            <ScrollArea className="rounded-md border bg-slate-950 p-3 pr-16">
              <code className="text-emerald-400 font-mono text-xs break-all">
                {command}
              </code>
            </ScrollArea>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyCommand}
              className="absolute top-1/2 -translate-y-1/2 right-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            >
              <Copy className="h-3 w-3" />
              {commandCopied ? " Copied!" : ""}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
