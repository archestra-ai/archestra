"use client";

import { Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { copyToClipboard } from "@/lib/clipboard";
import { isUsableTerminalDimensions } from "./exec-terminal.utils";

type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

/**
 * What the terminal reports back to whoever owns the connection.
 */
export type ExecSessionHandlers = {
  /** The session is live; `command` is the equivalent CLI invocation, if any. */
  onStarted: (command: string | null) => void;
  onOutput: (data: string) => void;
  onError: (message: string) => void;
  onClosed: (reason: string | null) => void;
};

/**
 * The connection itself, supplied by the caller.
 *
 * Keeping it out of this component is what lets one terminal serve both an MCP
 * server's debug shell and an Agent's live background run: the two speak
 * different WebSocket messages, but neither difference belongs to xterm
 * lifecycle, fitting, or the status chrome below.
 */
export type ExecSessionTransport = {
  /**
   * Open the session and return a teardown that also detaches server-side.
   *
   * May be called again on the same terminal: the server forgets every
   * subscription along with the socket it was made on, so a reconnect has to
   * re-open rather than leave a terminal that looks connected and receives
   * nothing.
   */
  open: (handlers: ExecSessionHandlers) => () => void;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
};

interface ExecTerminalProps {
  /**
   * Identifies the session. The terminal re-opens when this changes, so it —
   * not the transport's object identity — decides when to reconnect; a caller
   * that forgets to memoize its transport therefore cannot cause a reconnect
   * loop.
   */
  sessionKey: string;
  transport: ExecSessionTransport;
  /** False while the terminal is hidden, so a background tab holds no session. */
  isActive: boolean;
  title?: string;
  /** Heading for the copyable equivalent command, when the session reports one. */
  manualCommandTitle?: string;
  /** Copy shown while the owning resource settles after its pty closes. */
  disconnectedLabel?: string;
  onClosed?: () => void;
}

export function ExecTerminal({
  sessionKey,
  transport,
  isActive,
  title = "Interactive Shell",
  manualCommandTitle = "Manual Command",
  disconnectedLabel = "Session terminated",
  onClosed,
}: ExecTerminalProps) {
  // Read through a ref so a new transport object on every render cannot
  // retrigger the effect; `sessionKey` is the reconnect signal.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<import("@xterm/xterm").Terminal | null>(
    null,
  );
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
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
    // `sessionKey` is read here as well as being the reconnect signal: an
    // empty one means there is nothing to attach to yet.
    if (
      !sessionKey ||
      !isActive ||
      !terminalRef.current ||
      initializedRef.current
    )
      return;

    let disposed = false;

    const init = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      // Dynamically import the CSS
      await import("@xterm/xterm/css/xterm.css");

      if (disposed || !terminalRef.current) return;

      const fitAddon = new FitAddon();
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        theme: {
          background: "#020617", // slate-950 — matches logs container
          foreground: "#34d399", // emerald-400 — matches logs
          cursor: "#34d399",
        },
        scrollback: 5000,
      });

      terminal.loadAddon(fitAddon);
      terminal.open(terminalRef.current);

      // FitAddon can resize xterm for reasons other than an element resize
      // (font metrics settling is the common one). Drive the remote PTY from
      // xterm's authoritative dimensions so tmux can never remain at a stale
      // width while the browser terminal has already expanded.
      terminal.onResize(({ cols, rows }) => {
        if (!disposed && isUsableTerminalDimensions({ cols, rows })) {
          transportRef.current.sendResize(cols, rows);
        }
      });

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

      setStatus("connecting");
      setErrorMessage(null);

      const closeSession = transportRef.current.open({
        onStarted: (startedCommand) => {
          if (disposed) return;
          setStatus("connected");
          setCommand(startedCommand);
          const dims = fitAddon.proposeDimensions();
          if (isUsableTerminalDimensions(dims)) {
            transportRef.current.sendResize(dims.cols, dims.rows);
          }
        },
        onOutput: (data) => {
          if (disposed) return;
          terminal.write(data);
        },
        onError: (message) => {
          if (disposed) return;
          setStatus("error");
          setErrorMessage(message);
        },
        onClosed: (reason) => {
          if (disposed) return;
          setClosedReason(reason);
          setStatus("disconnected");
          onClosedRef.current?.();
        },
      });

      terminal.onData((data) => {
        transportRef.current.sendInput(data);
      });

      // Resize observer
      const resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        try {
          fitAddon.fit();
        } catch {
          // Ignore fit errors during transitions
        }
      });

      if (terminalRef.current) {
        resizeObserver.observe(terminalRef.current);
      }

      return () => {
        resizeObserver.disconnect();
        closeSession();
      };
    };

    const cleanupPromise = init();

    return () => {
      disposed = true;
      cleanupPromise?.then((cleanupFn) => cleanupFn?.());
      cleanup();
    };
  }, [isActive, sessionKey, cleanup]);

  const statusText = {
    idle: "",
    connecting: "Connecting...",
    connected: "",
    disconnected: closedReason
      ? `${disconnectedLabel} — ${closedReason}`
      : disconnectedLabel,
    error: errorMessage || "Connection error",
  }[status];

  const [commandCopied, setCommandCopied] = useState(false);

  const handleCopyCommand = useCallback(async () => {
    if (!command) return;
    try {
      await copyToClipboard(command);
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
        {title && (
          <h3 className="text-sm font-semibold flex-shrink-0">{title}</h3>
        )}
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
            className="flex-1 min-h-0 p-4 pb-2"
            style={{ display: status === "connecting" ? "none" : "block" }}
          >
            <div ref={terminalRef} className="h-full" />
          </div>
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
          <h3 className="text-sm font-semibold">{manualCommandTitle}</h3>
          <div className="relative">
            <ScrollArea className="rounded-md border bg-slate-950 p-3 pr-16">
              <code className="text-emerald-400 font-mono text-xs break-all">
                {command}
              </code>
            </ScrollArea>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Copy terminal command"
              onClick={handleCopyCommand}
              className="absolute top-1/2 -translate-y-1/2 right-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            >
              <Copy className="h-3 w-3" />
              {commandCopied ? <span> Copied!</span> : null}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
