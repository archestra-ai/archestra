"use client";

import { Copy, SquareTerminal } from "lucide-react";
import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { FileDropZone } from "@/components/files/file-drop-zone";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils/tailwind";
import styles from "./exec-terminal.module.css";
import { isUsableTerminalDimensions } from "./exec-terminal.utils";
import {
  type ExecSessionProgress,
  ExecTerminalProgress,
  ExecTerminalStatus,
} from "./exec-terminal-progress";

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
  /**
   * A wait the session is still in, before it is live.
   *
   * Optional because not every transport can see inside its own startup: one
   * attaching to a pod that is already running has nothing to report, and gets
   * the plain connecting state instead.
   */
  onProgress?: (progress: ExecSessionProgress) => void;
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
  /** Claude-specific mouse workaround; other terminal apps keep their protocol. */
  claudeMouseWorkaround?: boolean;
  /** False while the terminal is hidden, so a background tab holds no session. */
  isActive: boolean;
  title?: string;
  /** Heading for the copyable equivalent command, when the session reports one. */
  manualCommandTitle?: string;
  /** Whether to render the equivalent command below the terminal. */
  showManualCommand?: boolean;
  /** Copy shown while the owning resource settles after its pty closes. */
  disconnectedLabel?: string;
  /** Whether a closed PTY should add a status banner above its retained frame. */
  showDisconnectedStatus?: boolean;
  /** Snapshot shown immediately while the live transport catches up. */
  initialProgress?: ExecSessionProgress | null;
  /** Stable start time for the elapsed counter, such as the run's start. */
  progressStartedAt?: number;
  /**
   * Accept files dropped on a live terminal. Resolves with the path of each
   * stored file; the paths are then typed at the prompt for the user to send.
   */
  onDropFiles?: (files: File[]) => Promise<string[]>;
  onCommandChange?: (command: string | null) => void;
  onError?: () => void;
  onClosed?: () => void;
}

export function ExecTerminal({
  sessionKey,
  transport,
  claudeMouseWorkaround = false,
  isActive,
  title = "Interactive Shell",
  manualCommandTitle = "Manual Command",
  showManualCommand = true,
  disconnectedLabel = "Session terminated",
  showDisconnectedStatus = true,
  initialProgress = null,
  progressStartedAt,
  onDropFiles,
  onCommandChange,
  onError,
  onClosed,
}: ExecTerminalProps) {
  // Read through a ref so a new transport object on every render cannot
  // retrigger the effect; `sessionKey` is the reconnect signal.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const claudeMouseWorkaroundRef = useRef(claudeMouseWorkaround);
  claudeMouseWorkaroundRef.current = claudeMouseWorkaround;
  const initialProgressRef = useRef(initialProgress);
  initialProgressRef.current = initialProgress;
  const hasTransportProgressRef = useRef(false);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onCommandChangeRef = useRef(onCommandChange);
  onCommandChangeRef.current = onCommandChange;
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<import("@xterm/xterm").Terminal | null>(
    null,
  );
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [progress, setProgress] = useState<ExecSessionProgress | null>(null);
  /**
   * When the current attach began. Reset per attempt so a reconnect's elapsed
   * counter starts from that attempt, not from when the page was opened.
   */
  const [connectingSince, setConnectingSince] = useState(() => Date.now());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const [focusTerminal, setFocusTerminal] = useState(true);
  const focusTerminalRef = useRef(focusTerminal);

  const handleFocusTerminalChange = (focused: boolean) => {
    // Update before React renders: a pending paste or mouse report must not
    // slip through after switching to browser mode.
    focusTerminalRef.current = focused;
    setFocusTerminal(focused);
    const terminal = terminalInstanceRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = !focused;
    terminal.clearSelection();
    // A mode change relinquishes input focus in either direction. Enabling
    // terminal controls must not capture keystrokes until the user clicks it.
    terminal.blur();
    if (terminal.textarea) terminal.textarea.disabled = !focused;
  };

  const handleBrowserEvent = (event: SyntheticEvent) => {
    // Keep the browser's default action, but stop xterm's listeners from
    // focusing its hidden textarea, copying its selection or sending input.
    if (!focusTerminalRef.current) event.stopPropagation();
  };

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
          background: "#0a0a0a",
          foreground: "#e5e5e5",
          cursor: "#e5e5e5",
        },
        scrollback: 5000,
        scrollSensitivity: TERMINAL_SCROLL_SENSITIVITY,
        disableStdin: !focusTerminalRef.current,
      });

      terminal.loadAddon(fitAddon);
      terminal.open(terminalRef.current);
      if (terminal.textarea) {
        terminal.textarea.disabled = !focusTerminalRef.current;
      }
      const copyTerminalText = (text: string) => {
        void copyToClipboard(text).catch(() => {
          toast.error("Could not copy terminal text to clipboard");
        });
      };
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
          copyTerminalText(terminal.getSelection());
          return false;
        }
        return true;
      });
      // Native TUIs (including OpenCode's copy-on-select) send OSC 52 rather
      // than a browser copy event. Bridge writes to the host clipboard while
      // the user is in terminal mode; never answer clipboard-read queries.
      terminal.parser.registerOscHandler(52, (data) => {
        if (disposed || !focusTerminalRef.current || !document.hasFocus()) {
          return true;
        }
        const separator = data.indexOf(";");
        if (separator === -1) return true;
        const encoded = data.slice(separator + 1);
        if (encoded === "?") return true;
        try {
          const bytes = Uint8Array.from(atob(encoded), (char) =>
            char.charCodeAt(0),
          );
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          copyTerminalText(text);
        } catch {
          // Ignore malformed terminal reports without breaking its output.
        }
        return true;
      });

      // FitAddon can resize xterm for reasons other than an element resize
      // (font metrics settling is the common one). Drive the remote PTY from
      // xterm's authoritative dimensions so tmux can never remain at a stale
      // width while the browser terminal has already expanded.
      terminal.onResize(({ cols, rows }) => {
        if (!disposed && isUsableTerminalDimensions({ cols, rows })) {
          transportRef.current.sendResize(cols, rows);
        }
      });

      terminalInstanceRef.current = terminal;
      fitAddonRef.current = fitAddon;
      initializedRef.current = true;

      let closeSession: (() => void) | undefined;
      let layoutReady = false;

      const fitAndOpenSession = () => {
        if (disposed || closeSession) return;
        const dims = fitAddon.proposeDimensions();
        if (!layoutReady || !isUsableTerminalDimensions(dims)) return;
        try {
          fitAddon.fit();
        } catch {
          return;
        }

        setStatus("connecting");
        hasTransportProgressRef.current = false;
        setProgress(initialProgressRef.current);
        setConnectingSince(Date.now());
        setErrorMessage(null);

        // Do not subscribe until the terminal has a real grid. Otherwise the
        // first tmux frame can arrive at a transient 1-column tab width and
        // remain scrambled in scrollback after the panel finishes laying out.
        closeSession = transportRef.current.open({
          onProgress: (sessionProgress) => {
            if (disposed) return;
            hasTransportProgressRef.current = true;
            setProgress(sessionProgress);
          },
          onStarted: (startedCommand) => {
            if (disposed) return;
            setStatus("connected");
            setProgress(null);
            setCommand(startedCommand);
            onCommandChangeRef.current?.(startedCommand);
            const startedDims = fitAddon.proposeDimensions();
            if (isUsableTerminalDimensions(startedDims)) {
              transportRef.current.sendResize(
                startedDims.cols,
                startedDims.rows,
              );
            }
          },
          onOutput: (data) => {
            if (disposed) return;
            const output = withoutTmuxExitNotice(data);
            if (output) terminal.write(output);
          },
          onError: (message) => {
            if (disposed) return;
            setStatus("error");
            setErrorMessage(message);
            onErrorRef.current?.();
          },
          onClosed: (reason) => {
            if (disposed) return;
            setClosedReason(reason);
            setStatus("disconnected");
            onClosedRef.current?.();
          },
        });
      };

      terminal.onData((data) => {
        if (disposed || !focusTerminalRef.current) return;
        const input = claudeMouseWorkaroundRef.current
          ? normalizeTerminalInput(data)
          : data;
        if (input) transportRef.current.sendInput(input);
      });

      // Resize observer
      const resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        const dims = fitAddon.proposeDimensions();
        if (!isUsableTerminalDimensions(dims)) return;
        try {
          fitAddon.fit();
        } catch {
          // Ignore fit errors during transitions
        }
        fitAndOpenSession();
      });

      if (terminalRef.current) {
        resizeObserver.observe(terminalRef.current);
      }

      // Two frames let Radix tabs and the responsive grid settle before the
      // first PTY frame is allowed in. ResizeObserver remains the fallback for
      // a panel that becomes visible later.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          layoutReady = true;
          fitAndOpenSession();
        });
      });

      return () => {
        resizeObserver.disconnect();
        closeSession?.();
      };
    };

    const cleanupPromise = init();

    return () => {
      disposed = true;
      cleanupPromise?.then((cleanupFn) => cleanupFn?.());
      cleanup();
    };
  }, [isActive, sessionKey, cleanup]);

  useEffect(() => {
    if (status === "connecting" && !hasTransportProgressRef.current) {
      setProgress(initialProgress);
    }
  }, [initialProgress, status]);

  const [commandCopied, setCommandCopied] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);

  const handleDropFiles = useCallback(
    async (files: File[]) => {
      if (!onDropFiles || status !== "connected") return;
      setUploadingFiles(true);
      try {
        const paths = await onDropFiles(files);
        if (paths.length === 0) return;
        // Typed rather than bracketed-pasted: Claude Code drops all but the
        // first of back-to-back pastes, and plain paths work in every CLI.
        transportRef.current.sendInput(`${paths.join(" ")} `);
        terminalInstanceRef.current?.focus();
      } finally {
        setUploadingFiles(false);
      }
    },
    [onDropFiles, status],
  );

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

  const terminalAreaClassName = cn(
    "flex-1 min-h-0 p-4 pb-2",
    status === "connecting" ||
      status === "error" ||
      (status === "disconnected" && showDisconnectedStatus)
      ? "hidden"
      : "block",
  );
  const terminalArea = (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: xterm owns the interactive textarea; this wrapper gates its events. */}
      <div
        ref={terminalRef}
        className={`h-full ${focusTerminal ? "" : styles.browserMode}`}
        onMouseDownCapture={handleBrowserEvent}
        onMouseUpCapture={handleBrowserEvent}
        onMouseMoveCapture={handleBrowserEvent}
        onClickCapture={handleBrowserEvent}
        onDoubleClickCapture={handleBrowserEvent}
        onWheelCapture={handleBrowserEvent}
        onCopyCapture={handleBrowserEvent}
        onPasteCapture={handleBrowserEvent}
        onKeyDownCapture={handleBrowserEvent}
        onKeyUpCapture={handleBrowserEvent}
        onKeyDown={(event) => {
          if (focusTerminalRef.current) event.stopPropagation();
        }}
        onKeyUp={(event) => {
          if (focusTerminalRef.current) event.stopPropagation();
        }}
        onContextMenuCapture={(event) => {
          // Let xterm handle the right click in terminal mode; suppress
          // only the browser menu that would otherwise cover tmux's.
          // Browser mode keeps native defaults without reaching xterm.
          handleBrowserEvent(event);
          if (focusTerminalRef.current) event.preventDefault();
        }}
      />
    </>
  );

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex flex-col gap-2 flex-1 min-h-0">
        <div className="flex items-center justify-between gap-3 flex-shrink-0">
          {title ? <h3 className="text-sm font-semibold">{title}</h3> : <div />}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Focus terminal"
                aria-pressed={focusTerminal}
                onClick={() => handleFocusTerminalChange(!focusTerminal)}
                className="shrink-0 text-xs aria-pressed:bg-accent aria-pressed:text-accent-foreground"
              >
                <SquareTerminal />
                <span>Focus terminal</span>
                <span className="text-muted-foreground">
                  {focusTerminal ? "On" : "Off"}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {focusTerminal
                ? "Terminal controls enabled. Click inside to type. Turn off for browser selection, copy and context menu."
                : "Browser selection, copy and context menu enabled. Turn on to use terminal controls."}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-col flex-1 min-h-0 rounded-md border bg-slate-950 overflow-hidden">
          {status === "connecting" &&
            (progress ? (
              <ExecTerminalProgress
                progress={progress}
                startedAt={progressStartedAt ?? connectingSince}
              />
            ) : (
              <ExecTerminalStatus
                title="Connecting to the terminal"
                tone="loading"
              />
            ))}
          {status === "error" ? (
            <ExecTerminalStatus
              title="Unable to open the terminal"
              detail={errorMessage || "The terminal connection failed."}
              tone="error"
            />
          ) : null}
          {status === "disconnected" && showDisconnectedStatus ? (
            <ExecTerminalStatus
              title={disconnectedLabel}
              detail={closedReason}
              tone="warning"
            />
          ) : null}
          {onDropFiles ? (
            <FileDropZone
              onDropFiles={handleDropFiles}
              uploading={uploadingFiles}
              className={terminalAreaClassName}
            >
              {terminalArea}
            </FileDropZone>
          ) : (
            <div className={terminalAreaClassName}>{terminalArea}</div>
          )}
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

      {showManualCommand && command && (
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

// A TUI can ask the outer terminal for all mouse motion (DECSET 1003). tmux
// forwards those SGR reports to the pane, but some Claude Code render states
// stop consuming no-button hover events and insert them into the prompt as
// visible `^[[<35;...M` text. Only opt Claude into this workaround; other TUIs
// use hover for hit testing and selection. Drop only
// motion reports whose low button bits mean "no button". Clicks, button drags,
// wheel events, and ordinary keyboard input continue to the remote PTY.
function normalizeTerminalInput(data: string): string {
  return data.replace(SGR_MOUSE_REPORT_PATTERN, (report, encodedButton) => {
    const button = Number(encodedButton);
    const isMotion = (button & 32) !== 0;
    const hasNoButton = (button & 3) === 3;
    if (isMotion && hasNoButton) return "";

    // tmux owns scrolling while a TUI has mouse reporting enabled. One report
    // per browser wheel tick makes its copy-mode history feel much slower than
    // the rest of the app, so give wheel reports a modest boost. Clicks,
    // drags, and keyboard input remain byte-for-byte unchanged.
    const isWheel = (button & 64) !== 0;
    return isWheel ? report.repeat(REMOTE_WHEEL_SCROLL_MULTIPLIER) : report;
  });
}

function withoutTmuxExitNotice(data: string): string {
  const exitNoticeIndex = data.indexOf(TMUX_EXIT_NOTICE);
  if (exitNoticeIndex === -1) return data;

  // tmux can put the alternate-screen teardown and its own `[exited]` notice
  // in the same final chunk. Replaying the teardown replaces the useful TUI
  // frame with the empty shell screen just before the socket closes. Keep any
  // output before that teardown and let the execution header convey the end.
  const alternateScreenExitIndex = data.lastIndexOf(
    ALTERNATE_SCREEN_EXIT_SEQUENCE,
    exitNoticeIndex,
  );
  const visibleOutput = data.slice(
    0,
    alternateScreenExitIndex === -1
      ? exitNoticeIndex
      : alternateScreenExitIndex,
  );
  return visibleOutput.replace(/\r?\n$/, "");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC begins every SGR mouse report.
const SGR_MOUSE_REPORT_PATTERN = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
const TMUX_EXIT_NOTICE = "[exited]";
const ALTERNATE_SCREEN_EXIT_SEQUENCE = "\u001b[?1049l";
const REMOTE_WHEEL_SCROLL_MULTIPLIER = 3;
const TERMINAL_SCROLL_SENSITIVITY = 3;
