"use client";

import { useEffect, useRef, useState } from "react";
import type { snapshotTerminalRecording } from "./terminal-recording-snapshot";

type SnapshotLine = ReturnType<
  typeof snapshotTerminalRecording
>["lines"][number];
type DisplayLine = Omit<SnapshotLine, "runs"> & {
  runs: (SnapshotLine["runs"][number] & { key: string })[];
};

export function TerminalRecordingBlock({
  lines,
  wrapLines,
  cell = null,
  virtualize,
}: {
  lines: DisplayLine[];
  wrapLines: boolean;
  /** The measured cell in px; null until measured. */
  cell?: { width: number; height: number } | null;
  virtualize: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!virtualize);
  const [width, setWidth] = useState(0);
  const [measurement, setMeasurement] = useState<{
    lines: DisplayLine[];
    wrapLines: boolean;
    width: number;
    height: number;
  } | null>(null);
  const measuredHeight =
    measurement?.lines === lines &&
    measurement.wrapLines === wrapLines &&
    measurement.width === width
      ? measurement.height
      : null;
  useEffect(() => {
    if (!virtualize) {
      setVisible(true);
      return;
    }
    const element = root.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const selection = window.getSelection();
        setVisible(
          entry.isIntersecting ||
            element.contains(document.activeElement) ||
            Boolean(selection?.containsNode(element, true)),
        );
      },
      {
        root: element.closest('[data-testid="terminal-playback-viewport"]'),
        rootMargin: "1200px",
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [virtualize]);
  useEffect(() => {
    const element = root.current;
    if (!element || !virtualize) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      setWidth(bounds.width);
      if (visible)
        setMeasurement((previous) =>
          previous?.lines === lines &&
          previous.wrapLines === wrapLines &&
          previous.width === bounds.width &&
          previous.height === bounds.height
            ? previous
            : { lines, wrapLines, width: bounds.width, height: bounds.height },
        );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [visible, virtualize, lines, wrapLines]);
  const estimatedRows =
    !wrapLines || !width
      ? lines.length
      : lines.reduce(
          (total, line) =>
            total +
            Math.max(
              1,
              Math.ceil(
                line.runs.reduce((cells, run) => cells + run.cells, 0) /
                  Math.max(1, width / (cell?.width ?? FALLBACK_CELL.width)),
              ),
            ),
          0,
        );
  return (
    <div
      ref={root}
      data-recording-block={lines[0].row}
      style={
        visible
          ? undefined
          : {
              height:
                measuredHeight ??
                estimatedRows * (cell?.height ?? FALLBACK_CELL.height),
            }
      }
    >
      {visible &&
        lines.map((line) => (
          <div
            key={line.row}
            data-terminal-row={line.row}
            className="min-h-[1lh]"
            style={
              wrapLines
                ? undefined
                : { direction: "ltr", unicodeBidi: "bidi-override" }
            }
          >
            {line.runs.map((run) => {
              // On the grid every run is an inline block of the row's height,
              // as in xterm's own DOM renderer, so a coloured block keeps no
              // gap between its rows even where a glyph falls back to a font
              // with other metrics. Sized in whole cells, a run starts at its
              // column's position in every row: sized by its text, the
              // browser rounded each run's width, and a row split into more
              // runs moved a divider's edge by a device pixel.
              const joins = joinsAdjacentCells(run.text);
              const runWidth = cell
                ? `${run.cells * cell.width}px`
                : run.fixedWidth
                  ? `${run.cells}ch`
                  : undefined;
              const style = {
                ...run.style,
                ...(!wrapLines
                  ? {
                      display: "inline-block",
                      verticalAlign: "top",
                      ...(runWidth ? { width: runWidth } : {}),
                    }
                  : {}),
                ...(joins ? JOINING_CELL_STYLE : {}),
              };
              const text = joins ? (
                <span key={run.key} style={STRETCHED_GLYPH_STYLE}>
                  {run.text}
                </span>
              ) : (
                run.text
              );
              return run.url ? (
                <a
                  key={run.key}
                  href={run.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-dashed underline-offset-2"
                  style={{
                    ...style,
                    textDecorationLine: style.textDecorationLine?.includes(
                      "underline",
                    )
                      ? style.textDecorationLine
                      : `underline ${style.textDecorationLine ?? ""}`,
                  }}
                >
                  {text}
                </a>
              ) : (
                <span key={run.key} style={style}>
                  {text}
                </span>
              );
            })}
          </div>
        ))}
    </div>
  );
}

// ===================== internals =====================

/** A 12px monospace cell, for estimates before the font is measured. */
const FALLBACK_CELL = { width: 7.2, height: 14.4 };

/**
 * Fonts draw box-drawing and block characters to their own metrics, which the
 * browser rounds, so they stop a fraction of a pixel short of their cell and a
 * divider, a rule or a logo showed as dashes. Each is stretched a little past
 * its cell and clipped to it, as xterm's own glyphs fill their cell: unclipped,
 * neighbours overlapped and the overlaps showed as brighter ticks.
 */
const JOINING_CELL_STYLE = {
  display: "inline-block",
  verticalAlign: "top",
  overflow: "hidden",
} as const;
const STRETCHED_GLYPH_STYLE = {
  display: "inline-block",
  verticalAlign: "top",
  transform: "scale(1.1)",
} as const;

function joinsAdjacentCells(text: string): boolean {
  const code = text.codePointAt(0) ?? 0;
  return text.length === 1 && code >= 0x2500 && code <= 0x259f;
}
