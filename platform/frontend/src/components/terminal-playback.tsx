"use client";

import { useEffect, useRef } from "react";

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
        theme: {
          background: "#020617",
          foreground: "#34d399",
          cursor: "#34d399",
        },
      });

      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      fitAddon.fit();
      terminal.write(contentRef.current);
      renderedContentRef.current = contentRef.current;
      terminalRef.current = terminal;

      resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        try {
          fitAddon.fit();
        } catch {
          // The panel may be between layouts while an execution tab changes.
        }
      });
      resizeObserver.observe(containerRef.current);
    };

    void initialize();
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      renderedContentRef.current = "";
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const rendered = renderedContentRef.current;
    if (content.startsWith(rendered)) {
      terminal.write(content.slice(rendered.length));
    } else {
      terminal.reset();
      terminal.write(content);
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
