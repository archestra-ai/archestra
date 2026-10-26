"use client";

import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils/tailwind";
import { TerminalRecordingBlock } from "./terminal-recording-block";
import { prepareTerminalRecording } from "./terminal-recording-geometry";
import { inferTerminalRecordingLinks } from "./terminal-recording-links";
import {
  createTerminalReplayer,
  type TerminalReplayer,
} from "./terminal-recording-replay";
import { snapshotTerminalRecording } from "./terminal-recording-snapshot";

/**
 * Replays a captured PTY byte stream through xterm so cursor movement, clears,
 * and colour changes retain the terminal's structure, then displays the parsed
 * buffer as document content.
 */
export function TerminalPlayback({
  content,
  wrapLines = false,
}: {
  content: string;
  wrapLines?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<ReturnType<
    typeof snapshotTerminalRecording
  > | null>(null);
  const recording = useMemo(() => prepareTerminalRecording(content), [content]);
  const renderRecordingRef = useRef<((next: TerminalRecording) => void) | null>(
    null,
  );
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const replayerRef = useRef<TerminalReplayer | null>(null);
  const lines = useMemo(() => {
    if (!snapshot) return [];
    const physical = snapshot.lines.map((line) => ({
      ...line,
      runs: line.runs.map((run) => ({
        ...run,
        key: `${line.row}:${run.column}`,
      })),
    }));
    if (!wrapLines) return physical;
    const wrapped: typeof physical = [];
    for (const line of physical) {
      const previous = wrapped.at(-1);
      // Keep large soft-wrapped lines within their physical 50-row block so
      // one logical line cannot bypass virtualization and mount the whole log.
      if (
        line.wrapped &&
        previous &&
        (snapshot.lines.length <= 5000 || line.row % 50 !== 0)
      ) {
        previous.runs.push(...line.runs);
      } else {
        wrapped.push({ ...line, runs: [...line.runs] });
      }
    }
    return wrapped;
  }, [snapshot, wrapLines]);

  const virtualize = (snapshot?.lines.length ?? 0) > 5000;
  const blocks = useMemo(() => {
    const groups: (typeof lines)[] = [];
    if (virtualize) {
      let currentBlock = -1;
      for (const line of lines) {
        const block = Math.floor(line.row / 50);
        if (block !== currentBlock) {
          groups.push([]);
          currentBlock = block;
        }
        groups[groups.length - 1].push(line);
      }
    } else {
      for (let offset = 0; offset < lines.length; offset += 50)
        groups.push(lines.slice(offset, offset + 50));
    }
    return groups;
  }, [lines, virtualize]);

  useEffect(() => {
    let disposed = false;
    let initializedTerminal: import("@xterm/xterm").Terminal | null = null;
    const initialize = async () => {
      const { Terminal } = await import("@xterm/xterm");
      if (disposed) return;

      const terminal = new Terminal({
        // Retained logs can contain bare line feeds from the container log
        // stream. Treat them as complete newlines so playback does not carry
        // the previous line's cursor column into the next one.
        convertEol: true,
        scrollback: RETAINED_SCROLLBACK_LINES,
      });
      initializedTerminal = terminal;

      // Alternate buffers have no scrollback and are discarded on exit. The
      // replayer keeps replay in the normal buffer, so snapshots retain
      // earlier output, and resizes xterm as tmux resized the recorded pane.
      const replayer = createTerminalReplayer(terminal);
      replayerRef.current = replayer;

      let rendered: TerminalRecording | null = null;
      let writing = false;
      let queued: TerminalRecording | null = null;
      let failures = 0;
      const renderRecording = (next: TerminalRecording) => {
        if (disposed) return;
        if (writing) {
          queued = next;
          return;
        }
        const append =
          rendered &&
          rendered.dimensions.cols === next.dimensions.cols &&
          rendered.dimensions.rows === next.dimensions.rows &&
          next.content.startsWith(rendered.content);
        const bytes =
          append && rendered
            ? next.content.slice(rendered.content.length)
            : next.content;
        if (!append) {
          if (rendered) terminal.reset();
          replayer.reset();
          terminal.resize(next.dimensions.cols, next.dimensions.rows);
        }
        rendered = next;
        writing = true;
        // reset() does not discard xterm's pending write buffer. Every write
        // completes before the next render starts, so a seek never meets old
        // bytes that could resurrect a later screen.
        void replayer.write(bytes).then(
          async () => {
            if (disposed) return;
            let view: ReturnType<typeof snapshotTerminalRecording> | null =
              null;
            if (!queued) {
              const length = terminal.buffer.active.length;
              if (length <= 5000) {
                view = snapshotTerminalRecording(terminal);
              } else {
                view = { cols: terminal.cols, rows: terminal.rows, lines: [] };
                // Yield between chunks while retaining the write lock to keep
                // the buffer stable. A queued seek discards this stale snapshot.
                for (let start = 0; start < length; start += 2000) {
                  if (disposed || queued) {
                    view = null;
                    break;
                  }
                  const chunk = snapshotTerminalRecording(terminal, {
                    start,
                    end: start + 2000,
                  });
                  view.lines.push(...chunk.lines);
                  await new Promise<void>((resolve) => setTimeout(resolve, 0));
                }
                while (view?.lines.length && !view.lines.at(-1)?.runs.length)
                  view.lines.pop();
              }
            }
            if (disposed) return;
            writing = false;
            failures = 0;
            if (queued) {
              const latest = queued;
              queued = null;
              renderRecording(latest);
            } else if (view) {
              inferTerminalRecordingLinks(view.lines);
              setSnapshot(view);
            }
          },
          (error: unknown) => {
            // A failed write leaves the buffer unknown: it is reset, and
            // the next render replays from the start instead of appending.
            // A recording that fails every replay is given up after a few.
            console.error("Terminal recording replay failed", error);
            if (disposed) return;
            terminal.reset();
            replayer.reset();
            writing = false;
            rendered = null;
            const latest = queued ?? next;
            queued = null;
            if (failures++ >= MAX_REPLAY_RETRIES) return;
            renderRecording(latest);
          },
        );
      };
      renderRecordingRef.current = renderRecording;
      renderRecording(recordingRef.current);
    };

    void initialize();
    return () => {
      disposed = true;
      replayerRef.current?.stop();
      initializedTerminal?.dispose();
      renderRecordingRef.current = null;
    };
  }, []);

  useEffect(() => {
    renderRecordingRef.current?.(recording);
  }, [recording]);

  // A recording opens on its latest output, as a terminal does: the first
  // screen with lines is scrolled to its end, and the view follows new output
  // while the reader is at the end. A reader who has scrolled up keeps their
  // place through later output and seeks.
  const viewportRef = useRef<HTMLDivElement>(null);
  const cellProbeRef = useRef<HTMLSpanElement>(null);
  const fontSize = useFittedFontSize({
    viewportRef,
    cellProbeRef,
    cols: snapshot?.cols,
    rows: snapshot?.rows,
    enabled: !wrapLines,
  });
  const openedAtEnd = useRef(false);
  const atEnd = useRef(true);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const track = () => {
      atEnd.current =
        viewport.scrollTop + viewport.clientHeight >=
        viewport.scrollHeight - FOLLOW_END_SLACK_PX;
    };
    viewport.addEventListener("scroll", track);
    return () => viewport.removeEventListener("scroll", track);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fitted font size resizes the document, which stays at its end
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !snapshot?.lines.length) return;
    if (openedAtEnd.current && !atEnd.current) return;
    openedAtEnd.current = true;
    viewport.scrollTop = viewport.scrollHeight;
  }, [snapshot, fontSize]);

  return (
    <div
      ref={viewportRef}
      className="min-h-0 min-w-0 flex-1 overflow-auto bg-slate-950 p-4 pb-2"
      data-testid="terminal-playback-viewport"
    >
      <div
        className={cn(
          "font-mono text-xs leading-[1.2] text-emerald-400",
          wrapLines
            ? "w-full whitespace-pre-wrap [overflow-wrap:anywhere]"
            : "w-max min-w-full whitespace-pre",
        )}
        data-testid="terminal-playback"
        data-recorded-cols={snapshot?.cols}
        data-recorded-rows={snapshot?.rows}
        style={
          wrapLines
            ? undefined
            : {
                minWidth: snapshot ? `max(100%, ${snapshot.cols}ch)` : "100%",
                ...(fontSize ? { fontSize } : {}),
              }
        }
      >
        <span
          ref={cellProbeRef}
          aria-hidden
          className="pointer-events-none invisible absolute"
          style={{ width: `${CELL_PROBE_CELLS}ch`, fontSize: BASE_FONT_PX }}
        />
        {blocks.map((block) => (
          <TerminalRecordingBlock
            key={block[0].row}
            lines={block}
            wrapLines={wrapLines}
            virtualize={virtualize}
          />
        ))}
      </div>
    </div>
  );
}

// ===================== internals =====================

const RETAINED_SCROLLBACK_LINES = 1_000_000;
/** Replays retried after a failed write before the player gives up. */
const MAX_REPLAY_RETRIES = 2;
/** How close to the end still counts as "at the end" for following output. */
const FOLLOW_END_SLACK_PX = 10;
/** The document's `text-xs` and `leading-[1.2]`. */
const BASE_FONT_PX = 12;
const LINE_HEIGHT_EM = 1.2;
/** A fitted screen stays legible, and a small one is not blown up. */
const MIN_FITTED_FONT_PX = 10;
const MAX_FITTED_FONT_PX = 16;
const CELL_PROBE_CELLS = 10;

type TerminalRecording = ReturnType<typeof prepareTerminalRecording>;

/**
 * The font size at which the recorded screen fills the viewport, as the live
 * terminal fills it by resizing the pane. A recording keeps the pane's size:
 * a run nobody watched stays at the runtime's 120x40, and drawn at the base
 * size a full-screen client's screen sat in a corner of a wide panel. The
 * last screen is fitted to the width and the height available, within
 * bounds; below the smallest size the grid scrolls. Null until measured.
 */
function useFittedFontSize({
  viewportRef,
  cellProbeRef,
  cols,
  rows,
  enabled,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  cellProbeRef: RefObject<HTMLSpanElement | null>;
  cols: number | undefined;
  rows: number | undefined;
  enabled: boolean;
}): number | null {
  const [fontSize, setFontSize] = useState<number | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const probe = cellProbeRef.current;
    if (!enabled || !viewport || !probe || !cols || !rows) {
      setFontSize(null);
      return;
    }
    const fit = () => {
      const style = getComputedStyle(viewport);
      const width =
        viewport.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      const height =
        viewport.clientHeight -
        Number.parseFloat(style.paddingTop) -
        Number.parseFloat(style.paddingBottom);
      // A cell's width in em, from the probe's cells at the base size.
      const cell =
        probe.getBoundingClientRect().width / CELL_PROBE_CELLS / BASE_FONT_PX;
      if (width <= 0 || height <= 0 || cell <= 0) return;
      const fitted = Math.min(
        width / (cols * cell),
        height / (rows * LINE_HEIGHT_EM),
      );
      // Quarter pixels, rounded down, so the grid never overflows by a hair.
      setFontSize(
        Math.floor(
          Math.min(MAX_FITTED_FONT_PX, Math.max(MIN_FITTED_FONT_PX, fitted)) *
            4,
        ) / 4,
      );
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewportRef, cellProbeRef, cols, rows, enabled]);
  return fontSize;
}
