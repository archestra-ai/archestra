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
  virtualize,
}: {
  lines: DisplayLine[];
  wrapLines: boolean;
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
                  Math.max(1, width / 7.2),
              ),
            ),
          0,
        );
  return (
    <div
      ref={root}
      data-recording-block={lines[0].row}
      style={
        visible ? undefined : { height: measuredHeight ?? estimatedRows * 14.4 }
      }
    >
      {visible &&
        lines.map((line) => (
          <div
            key={line.row}
            data-terminal-row={line.row}
            className="min-h-[1.2em]"
            style={
              wrapLines
                ? undefined
                : { direction: "ltr", unicodeBidi: "bidi-override" }
            }
          >
            {line.runs.map((run) => {
              const style = {
                ...run.style,
                ...(!wrapLines && run.fixedWidth
                  ? {
                      display: "inline-block",
                      width: `${run.cells}ch`,
                      verticalAlign: "top",
                    }
                  : {}),
              };
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
                  {run.text}
                </a>
              ) : (
                <span key={run.key} style={style}>
                  {run.text}
                </span>
              );
            })}
          </div>
        ))}
    </div>
  );
}
