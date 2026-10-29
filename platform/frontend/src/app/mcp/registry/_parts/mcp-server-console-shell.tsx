"use client";

import type {
  McpExecClosedMessage,
  McpExecErrorMessage,
  McpExecOutputMessage,
  McpExecStartedMessage,
} from "@archestra/shared";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import styles from "@/components/exec/exec-terminal.module.css";
import { isUsableTerminalDimensions } from "@/components/exec/exec-terminal.utils";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils/tailwind";
import websocketService from "@/lib/websocket/websocket";
import { ConsoleState, Pulse, StatusItem } from "./mcp-server-console-ui";

export type Shell = ReturnType<typeof useShellSession>;

/**
 * The same xterm lifecycle as ExecTerminal, with its chrome lifted out so the
 * console frame owns the toggle, status and command. Transport = McpExecTerminal.
 */
export function useShellSession(serverId: string | null, isActive: boolean) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<import("@xterm/xterm").Terminal | null>(
    null,
  );
  const [status, setStatus] = useState<ShellConnection>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [focusTerminal, setFocusTerminalState] = useState(true);
  const focusTerminalRef = useRef(true);

  const setFocusTerminal = (focused: boolean) => {
    focusTerminalRef.current = focused;
    setFocusTerminalState(focused);
    const terminal = terminalInstanceRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = !focused;
    terminal.clearSelection();
    terminal.blur();
    if (terminal.textarea) terminal.textarea.disabled = !focused;
  };

  useEffect(() => {
    // A different connection's command/error must never linger.
    setCommand(null);
    setErrorMessage(null);
    setClosedReason(null);
    if (!serverId || !isActive || !terminalRef.current) return;
    let disposed = false;
    let teardown: (() => void) | undefined;
    let startTimer: ReturnType<typeof setTimeout> | undefined;

    const init = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      await import("@xterm/xterm/css/xterm.css");
      if (disposed || !terminalRef.current) return;

      const fitAddon = new FitAddon();
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        lineHeight: 1.25,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        // Same surface as the console frame (slate-950) so the grid has no
        // second, blacker rectangle inside the panel.
        theme: {
          background: "#020617",
          foreground: "#e2e8f0",
          cursor: "#e2e8f0",
          selectionBackground: "#334155",
        },
        scrollback: 5000,
        scrollSensitivity: 3,
        disableStdin: !focusTerminalRef.current,
      });
      terminal.loadAddon(fitAddon);
      terminal.open(terminalRef.current);
      if (terminal.textarea) {
        terminal.textarea.disabled = !focusTerminalRef.current;
      }
      terminal.attachCustomKeyEventHandler((event) => {
        if (!focusTerminalRef.current) return false;
        if (
          event.type === "keydown" &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          event.key.toLowerCase() === "c" &&
          terminal.hasSelection()
        ) {
          event.preventDefault();
          void copyToClipboard(terminal.getSelection()).catch(() =>
            toast.error("Could not copy terminal text to clipboard"),
          );
          return false;
        }
        return true;
      });
      terminal.onResize(({ cols, rows }) => {
        if (!disposed && isUsableTerminalDimensions({ cols, rows })) {
          websocketService.send({
            type: "mcp_exec_resize",
            payload: { serverId, cols, rows },
          });
        }
      });
      terminalInstanceRef.current = terminal;

      let closeSession: (() => void) | undefined;
      let layoutReady = false;

      const openSession = () => {
        if (disposed || closeSession) return;
        const dims = fitAddon.proposeDimensions();
        if (!layoutReady || !isUsableTerminalDimensions(dims)) return;
        try {
          fitAddon.fit();
        } catch {
          return;
        }
        setStatus("connecting");
        setErrorMessage(null);
        websocketService.connect();
        startTimer = setTimeout(() => {
          if (disposed) return;
          setStatus((st) => {
            if (st !== "connecting") return st;
            setErrorMessage(
              "The pod didn't accept the exec session within 15 seconds.",
            );
            return "error";
          });
        }, 15000);
        const unsubs = [
          websocketService.subscribe(
            "mcp_exec_started",
            (m: McpExecStartedMessage) => {
              if (disposed || m.payload.serverId !== serverId) return;
              clearTimeout(startTimer);
              setStatus("connected");
              setCommand(m.payload.command);
              const d = fitAddon.proposeDimensions();
              if (isUsableTerminalDimensions(d)) {
                websocketService.send({
                  type: "mcp_exec_resize",
                  payload: { serverId, cols: d.cols, rows: d.rows },
                });
              }
            },
          ),
          websocketService.subscribe(
            "mcp_exec_output",
            (m: McpExecOutputMessage) => {
              if (disposed || m.payload.serverId !== serverId) return;
              terminal.write(m.payload.data);
            },
          ),
          websocketService.subscribe(
            "mcp_exec_error",
            (m: McpExecErrorMessage) => {
              if (disposed || m.payload.serverId !== serverId) return;
              setStatus("error");
              setErrorMessage(m.payload.error);
            },
          ),
          websocketService.subscribe(
            "mcp_exec_closed",
            (m: McpExecClosedMessage) => {
              if (disposed || m.payload.serverId !== serverId) return;
              setClosedReason(m.payload.reason ?? null);
              setStatus("disconnected");
            },
          ),
        ];
        const subscribe = () =>
          websocketService.send({
            type: "subscribe_mcp_exec",
            payload: { serverId },
          });
        // A reconnect drops server-side subscriptions; re-open the session.
        const offConn = websocketService.onConnectionChange((c) => {
          if (c) subscribe();
        });
        subscribe();
        closeSession = () => {
          offConn();
          for (const u of unsubs) u();
          websocketService.send({
            type: "unsubscribe_mcp_exec",
            payload: { serverId },
          });
        };
      };

      terminal.onData((data) => {
        if (disposed || !focusTerminalRef.current) return;
        websocketService.send({
          type: "mcp_exec_input",
          payload: { serverId, data },
        });
      });

      const ro = new ResizeObserver(() => {
        if (disposed) return;
        if (!isUsableTerminalDimensions(fitAddon.proposeDimensions())) return;
        try {
          fitAddon.fit();
        } catch {
          // ignore transitional fit errors
        }
        openSession();
      });
      ro.observe(terminalRef.current);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          layoutReady = true;
          openSession();
        }),
      );

      teardown = () => {
        ro.disconnect();
        closeSession?.();
      };
    };

    void init();
    return () => {
      disposed = true;
      clearTimeout(startTimer);
      teardown?.();
      terminalInstanceRef.current?.dispose();
      terminalInstanceRef.current = null;
      setStatus("idle");
    };
  }, [serverId, isActive]);

  return {
    terminalRef,
    status,
    errorMessage,
    closedReason,
    command,
    focusTerminal,
    setFocusTerminal,
    focusTerminalRef,
  };
}

export function ShellStatus({
  shell,
  active,
}: {
  shell: Shell;
  active: boolean;
}) {
  if (!active) {
    return (
      <StatusItem>
        <Pulse tone="off" />
        <span>Unavailable</span>
      </StatusItem>
    );
  }
  return (
    <>
      <StatusItem>
        {shell.status === "connected" ? (
          <>
            <Pulse tone="live" />
            <span className="text-emerald-400">Connected</span>
          </>
        ) : shell.status === "error" ? (
          <>
            <Pulse tone="err" />
            <span className="text-red-400">Error</span>
          </>
        ) : shell.status === "disconnected" ? (
          <>
            <Pulse tone="off" />
            <span>Session ended</span>
          </>
        ) : (
          <>
            <Pulse tone="warn" />
            <span>Connecting</span>
          </>
        )}
      </StatusItem>
      {shell.status === "connected" && (
        <StatusItem hideBelow="sm">
          <span className="text-slate-500">
            {shell.focusTerminal ? "input → pod" : "selecting text"}
          </span>
        </StatusItem>
      )}
    </>
  );
}

export function ShellBody({ shell }: { shell: Shell }) {
  const stop = (event: SyntheticEvent) => {
    if (!shell.focusTerminalRef.current) event.stopPropagation();
  };
  const hidden =
    shell.status === "connecting" ||
    shell.status === "error" ||
    shell.status === "disconnected";
  return (
    <>
      {shell.status === "connecting" && (
        <ConsoleState
          tone="loading"
          title="Opening a shell in the pod"
          detail="Attaching /bin/sh inside the mcp-server container."
        />
      )}
      {shell.status === "error" && (
        <ConsoleState
          tone="error"
          title="Unable to open the terminal"
          detail={shell.errorMessage || "The terminal connection failed."}
        />
      )}
      {shell.status === "disconnected" && (
        <ConsoleState
          tone="warning"
          title="Session terminated"
          detail={shell.closedReason}
        />
      )}
      <div className={cn("min-h-0 flex-1 py-2 pr-1 pl-3", hidden && "hidden")}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: xterm owns the interactive textarea; this wrapper gates its events. */}
        <div
          ref={shell.terminalRef}
          className={cn("h-full", !shell.focusTerminal && styles.browserMode)}
          onMouseDownCapture={stop}
          onMouseUpCapture={stop}
          onMouseMoveCapture={stop}
          onClickCapture={stop}
          onDoubleClickCapture={stop}
          onWheelCapture={stop}
          onCopyCapture={stop}
          onPasteCapture={stop}
          onKeyDownCapture={stop}
          onKeyUpCapture={stop}
          onKeyDown={(e) => {
            if (shell.focusTerminalRef.current) e.stopPropagation();
          }}
          onKeyUp={(e) => {
            if (shell.focusTerminalRef.current) e.stopPropagation();
          }}
          onContextMenuCapture={(e) => {
            stop(e);
            if (shell.focusTerminalRef.current) e.preventDefault();
          }}
        />
      </div>
    </>
  );
}

type ShellConnection =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";
