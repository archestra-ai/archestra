"use client";

import { useEffect, useRef } from "react";
import { isUsableTerminalDimensions } from "./exec/exec-terminal.utils";

/**
 * Replays a captured PTY byte stream through xterm so cursor movement, clears,
 * and colour changes retain the terminal's live structure while completed
 * output remains readable and scrollable.
 */
export function TerminalPlayback({ content }: { content: string }) {
  const recording = parseTerminalRecording(content);
  const viewportRef = useRef<HTMLDivElement>(null);
  const recordingFrameRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const updateRecordedScaleRef = useRef<() => void>(() => {});
  const recordingRef = useRef(recording);
  const renderedContentRef = useRef("");
  const recordedDimensionsRef = useRef<TerminalDimensions | null>(null);
  recordingRef.current = recording;

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
        // Retained logs can contain bare line feeds from the container log
        // stream. Treat them as complete newlines so playback does not carry
        // the previous line's cursor column into the next one.
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        fontSize: 12,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        lineHeight: TERMINAL_LINE_HEIGHT,
        scrollback: RETAINED_SCROLLBACK_LINES,
        scrollSensitivity: TERMINAL_SCROLL_SENSITIVITY,
        theme: {
          background: "#020617",
          foreground: "#34d399",
          cursor: "#34d399",
        },
      });
      initializedTerminal = terminal;

      // Full-screen TUIs use the alternate screen because a live terminal
      // should leave no history behind when they exit. That is exactly the
      // wrong behavior for a retained recording: xterm cannot scroll an
      // alternate buffer. Keep replay on the normal buffer so lines pushed
      // above the viewport remain available to the reader.
      terminal.parser.registerCsiHandler(
        { prefix: "?", final: "h" },
        containsAlternateScreenMode,
      );
      terminal.parser.registerCsiHandler(
        { prefix: "?", final: "l" },
        containsAlternateScreenMode,
      );

      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      let layoutReady = false;
      let rendered = false;
      let renderedDimensions: { cols: number; rows: number } | null = null;

      const updateRecordedScale = () => {
        const viewport = viewportRef.current;
        const frame = recordingFrameRef.current;
        const container = containerRef.current;
        if (
          !recordingRef.current.dimensions ||
          !viewport ||
          !frame ||
          !container
        ) {
          return;
        }

        const naturalWidth = container.offsetWidth;
        const naturalHeight = container.offsetHeight;
        if (naturalWidth <= 0 || naturalHeight <= 0) return;

        const availableWidth = Math.max(
          0,
          viewport.clientWidth - RETAINED_TERMINAL_HORIZONTAL_PADDING_PX,
        );
        const scale = Math.min(
          1,
          Math.max(MIN_RETAINED_TERMINAL_SCALE, availableWidth / naturalWidth),
        );

        container.style.transform = `scale(${scale})`;
        container.style.transformOrigin = "top left";
        frame.style.width = `${naturalWidth * scale}px`;
        frame.style.height = `${naturalHeight * scale}px`;
      };
      updateRecordedScaleRef.current = updateRecordedScale;

      const fitAndRender = () => {
        if (disposed) return;
        const currentRecording = recordingRef.current;
        if (currentRecording.dimensions) {
          if (!layoutReady) return;
          if (
            !sameDimensions(renderedDimensions, currentRecording.dimensions)
          ) {
            terminal.resize(
              currentRecording.dimensions.cols,
              currentRecording.dimensions.rows,
            );
          }
          if (!rendered) {
            terminal.write(withReadOnlyTerminalState(currentRecording.content));
            renderedContentRef.current = currentRecording.content;
            recordedDimensionsRef.current = currentRecording.dimensions;
            terminalRef.current = terminal;
            rendered = true;
          }
          renderedDimensions = currentRecording.dimensions;
          updateRecordedScale();
          return;
        }
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
          terminal.write(withReadOnlyTerminalState(currentRecording.content));
          renderedContentRef.current = currentRecording.content;
          recordedDimensionsRef.current = null;
          terminalRef.current = terminal;
          rendered = true;
        } else if (dimensionsChanged) {
          // A live TUI redraws after a PTY resize. A retained one cannot, so
          // replay its byte stream into the new grid instead of reflowing a
          // screen full of absolute cursor positions from the old dimensions.
          terminal.reset();
          terminal.write(withReadOnlyTerminalState(currentRecording.content));
          renderedContentRef.current = currentRecording.content;
        }
        renderedDimensions = dims;
      };

      resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        if (recordingRef.current.dimensions) {
          // Fitting changes xterm's column count and corrupts full-screen TUI
          // recordings that use absolute cursor positions. Keep the captured
          // grid intact and scale its canvas as a single unit instead.
          updateRecordedScale();
          return;
        }
        const dims = fitAddon.proposeDimensions();
        if (!isUsableTerminalDimensions(dims)) return;
        try {
          fitAddon.fit();
        } catch {
          // The panel may be between layouts while an execution tab changes.
        }
        fitAndRender();
      });
      resizeObserver.observe(viewportRef.current ?? containerRef.current);

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
      updateRecordedScaleRef.current = () => {};
      renderedContentRef.current = "";
      recordedDimensionsRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const nextRecording = parseTerminalRecording(content);
    const rendered = renderedContentRef.current;
    const dimensionsChanged = !sameDimensions(
      recordedDimensionsRef.current,
      nextRecording.dimensions,
    );
    if (nextRecording.dimensions && dimensionsChanged) {
      terminal.resize(
        nextRecording.dimensions.cols,
        nextRecording.dimensions.rows,
      );
      terminal.reset();
      terminal.write(withReadOnlyTerminalState(nextRecording.content));
      requestAnimationFrame(() => updateRecordedScaleRef.current());
    } else if (nextRecording.content.startsWith(rendered)) {
      terminal.write(
        withReadOnlyTerminalState(nextRecording.content.slice(rendered.length)),
      );
    } else {
      terminal.reset();
      terminal.write(withReadOnlyTerminalState(nextRecording.content));
    }
    renderedContentRef.current = nextRecording.content;
    recordedDimensionsRef.current = nextRecording.dimensions;
  }, [content]);

  return (
    <div
      ref={viewportRef}
      className="flex min-h-0 flex-1 overflow-auto bg-slate-950 p-4 pb-2"
      data-testid="terminal-playback-viewport"
    >
      <div
        ref={recordingFrameRef}
        className={recording.dimensions ? "shrink-0" : "flex min-h-0 flex-1"}
        style={
          recording.dimensions
            ? {
                height: `calc(${recording.dimensions.rows * 1.2}em + 0.5rem)`,
                width: `calc(${recording.dimensions.cols}ch + 0.5rem)`,
              }
            : undefined
        }
      >
        <div
          ref={containerRef}
          className={recording.dimensions ? "shrink-0" : "min-h-0 flex-1"}
          data-testid="terminal-playback"
          style={
            recording.dimensions
              ? {
                  height: `calc(${recording.dimensions.rows * 1.2}em + 0.5rem)`,
                  width: `calc(${recording.dimensions.cols}ch + 0.5rem)`,
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}

// ===================== internals =====================

const READ_ONLY_TERMINAL_STATE =
  "\u001b[?25l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1015l";
const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);
const RETAINED_SCROLLBACK_LINES = 1_000_000;
const TERMINAL_SCROLL_SENSITIVITY = 3;
const TERMINAL_LINE_HEIGHT = 1.2;
const MIN_RETAINED_TERMINAL_SCALE = 0.5;
const RETAINED_TERMINAL_HORIZONTAL_PADDING_PX = 32;
const TERMINAL_SIZE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\]777;archestra-terminal-size=(\\d+)x(\\d+)${String.fromCharCode(7)}`,
  "g",
);

interface TerminalDimensions {
  cols: number;
  rows: number;
}

interface TerminalRecording {
  content: string;
  dimensions: TerminalDimensions | null;
}

function withReadOnlyTerminalState(content: string): string {
  return `${content}${READ_ONLY_TERMINAL_STATE}`;
}

function containsAlternateScreenMode(params: (number | number[])[]): boolean {
  return params.some(
    (param) => typeof param === "number" && ALTERNATE_SCREEN_MODES.has(param),
  );
}

function parseTerminalRecording(content: string): TerminalRecording {
  let dimensions: TerminalDimensions | null = null;
  const sanitizedContent = content.replace(
    TERMINAL_SIZE_PATTERN,
    (_marker, cols: string, rows: string) => {
      dimensions = { cols: Number(cols), rows: Number(rows) };
      return "";
    },
  );
  return { content: sanitizedContent, dimensions };
}

function sameDimensions(
  left: TerminalDimensions | null,
  right: TerminalDimensions | null,
): boolean {
  return left?.cols === right?.cols && left?.rows === right?.rows;
}
