"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils/tailwind";
import { TerminalRecordingBlock } from "./terminal-recording-block";
import {
  parseTerminalSize,
  prepareTerminalRecording,
} from "./terminal-recording-geometry";
import { inferTerminalRecordingLinks } from "./terminal-recording-links";
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

      // Alternate buffers have no scrollback and are discarded on exit. Keep
      // replay in the normal buffer so snapshots retain earlier output.
      terminal.parser.registerCsiHandler(
        { prefix: "?", final: "h" },
        containsAlternateScreenMode,
      );
      terminal.parser.registerCsiHandler(
        { prefix: "?", final: "l" },
        containsAlternateScreenMode,
      );

      terminal.parser.registerOscHandler(777, (data) => {
        const size = parseTerminalSize(data);
        if (!size) return false;
        terminal.resize(size.cols, size.rows);
        return true;
      });

      let rendered: TerminalRecording | null = null;
      let writing = false;
      let queued: TerminalRecording | null = null;
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
          terminal.resize(next.dimensions.cols, next.dimensions.rows);
        }
        rendered = next;
        writing = true;
        // reset() does not discard xterm's pending write buffer. Drain it
        // before seeking, otherwise old bytes can resurrect a later screen.
        terminal.write(bytes, () => {
          const finish = async () => {
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
            if (queued) {
              const latest = queued;
              queued = null;
              renderRecording(latest);
            } else if (view) {
              inferTerminalRecordingLinks(view.lines);
              setSnapshot(view);
            }
          };
          void finish();
        });
      };
      renderRecordingRef.current = renderRecording;
      renderRecording(recordingRef.current);
    };

    void initialize();
    return () => {
      disposed = true;
      initializedTerminal?.dispose();
      renderRecordingRef.current = null;
    };
  }, []);

  useEffect(() => {
    renderRecordingRef.current?.(recording);
  }, [recording]);

  return (
    <div
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
            : { minWidth: snapshot ? `max(100%, ${snapshot.cols}ch)` : "100%" }
        }
      >
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

const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);
const RETAINED_SCROLLBACK_LINES = 1_000_000;

type TerminalRecording = ReturnType<typeof prepareTerminalRecording>;

function containsAlternateScreenMode(params: (number | number[])[]): boolean {
  return params.some(
    (param) => typeof param === "number" && ALTERNATE_SCREEN_MODES.has(param),
  );
}
