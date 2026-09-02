"use client";

import { useEffect, useRef } from "react";
import { isUsableTerminalDimensions } from "./exec/exec-terminal.utils";

/**
 * Replays a captured PTY byte stream through xterm so cursor movement, clears,
 * alternate-screen updates, and colour changes produce the same terminal
 * frame the user saw while the execution was live.
 */
export function TerminalPlayback({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const contentRef = useRef(content);
  const renderedContentRef = useRef("");
  contentRef.current = content;

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    let initializedTerminal: import("@xterm/xterm").Terminal | null = null;

    const initialize = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      await import("@xterm/xterm/css/xterm.css");
      if (disposed || !containerRef.current) return;

      const fitAddon = new FitAddon();
      const terminal = new Terminal({
        convertEol: false,
        cursorBlink: false,
        disableStdin: true,
        fontSize: 12,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        scrollback: 5000,
        scrollSensitivity: TERMINAL_SCROLL_SENSITIVITY,
        theme: {
          background: "#020617",
          foreground: "#34d399",
          cursor: "#34d399",
        },
      });
      initializedTerminal = terminal;

      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      let layoutReady = false;
      let rendered = false;
      let renderedDimensions: { cols: number; rows: number } | null = null;

      const fitAndRender = () => {
        if (disposed) return;
        const dims = fitAddon.proposeDimensions();
        if (!layoutReady || !isUsableTerminalDimensions(dims)) return;
        const dimensionsChanged =
          renderedDimensions !== null &&
          (renderedDimensions.cols !== dims.cols ||
            renderedDimensions.rows !== dims.rows);
        try {
          fitAddon.fit();
        } catch {
          return;
        }
        if (!rendered) {
          terminal.write(withReadOnlyTerminalState(contentRef.current));
          renderedContentRef.current = contentRef.current;
          terminalRef.current = terminal;
          rendered = true;
        } else if (dimensionsChanged) {
          // A live TUI redraws after a PTY resize. A retained one cannot, so
          // replay its byte stream into the new grid instead of reflowing a
          // screen full of absolute cursor positions from the old dimensions.
          terminal.reset();
          terminal.write(withReadOnlyTerminalState(contentRef.current));
          renderedContentRef.current = contentRef.current;
        }
        renderedDimensions = dims;
      };

      resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        const dims = fitAddon.proposeDimensions();
        if (!isUsableTerminalDimensions(dims)) return;
        try {
          fitAddon.fit();
        } catch {
          // The panel may be between layouts while an execution tab changes.
        }
        fitAndRender();
      });
      resizeObserver.observe(containerRef.current);

      // Avoid replaying a whole TUI recording into the transient dimensions
      // produced while the surrounding tab/grid is still mounting.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          layoutReady = true;
          fitAndRender();
        });
      });
    };

    void initialize();
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      initializedTerminal?.dispose();
      terminalRef.current = null;
      renderedContentRef.current = "";
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const rendered = renderedContentRef.current;
    if (content.startsWith(rendered)) {
      terminal.write(withReadOnlyTerminalState(content.slice(rendered.length)));
    } else {
      terminal.reset();
      terminal.write(withReadOnlyTerminalState(content));
    }
    renderedContentRef.current = content;
  }, [content]);

  return (
    <div className="min-h-0 flex-1 bg-slate-950 p-4 pb-2">
      <div
        ref={containerRef}
        className="h-full"
        data-testid="terminal-playback"
      />
    </div>
  );
}

// ===================== internals =====================

const READ_ONLY_TERMINAL_STATE =
  "\u001b[?25l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1015l";
const TERMINAL_SCROLL_SENSITIVITY = 3;

function withReadOnlyTerminalState(content: string): string {
  return `${content}${READ_ONLY_TERMINAL_STATE}`;
}
