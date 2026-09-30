"use client";

import {
  ChevronLeft,
  ChevronRight,
  SkipBack,
  SkipForward,
  WrapText,
} from "lucide-react";
import { useMemo, useState } from "react";
import { TerminalPlayback } from "@/components/terminal-playback";
import { indexTerminalRecording } from "@/components/terminal-recording-index";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

/** A terminal recording is a sequence of screens, not just its final buffer. */
export function TerminalRecording({ content }: { content: string }) {
  const positions = useMemo(() => indexTerminalRecording(content), [content]);
  const [selectedOffset, setSelectedOffset] = useState<number | null>(null);
  const [wrapLines, setWrapLines] = useState(false);
  const last = positions.length - 1;
  const matchingPosition =
    selectedOffset === null
      ? -1
      : positions.findIndex((offset) => offset >= selectedOffset);
  const position = matchingPosition === -1 ? last : matchingPosition;
  const replay =
    selectedOffset === null ? content : content.slice(0, positions[position]);
  const seek = (next: number) =>
    setSelectedOffset(next >= last ? null : positions[Math.max(0, next)]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-1 text-slate-400">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Recording start"
          onClick={() => seek(0)}
          disabled={position === 0}
        >
          <SkipBack />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous recorded screen"
          onClick={() => seek(position - 1)}
          disabled={position === 0}
        >
          <ChevronLeft />
        </Button>
        <Slider
          aria-label="Recording position"
          min={0}
          max={Math.max(1, last)}
          step={1}
          value={[position]}
          onValueChange={([next]) => seek(next)}
          disabled={last === 0}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next recorded screen"
          onClick={() => seek(position + 1)}
          disabled={position === last}
        >
          <ChevronRight />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Recording end"
          onClick={() => seek(last)}
          disabled={position === last}
        >
          <SkipForward />
        </Button>
        <span className="min-w-10 text-right text-xs tabular-nums">
          {position === last
            ? "End"
            : `${Math.round((position / Math.max(1, last)) * 100)}%`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Wrap lines"
          aria-pressed={wrapLines}
          title={
            wrapLines
              ? "Restore original layout"
              : "Wrap lines to the available width"
          }
          onClick={() => setWrapLines((value) => !value)}
          className="shrink-0 text-xs aria-pressed:bg-slate-800 aria-pressed:text-slate-200"
        >
          <WrapText />
          <span className="hidden sm:inline">Wrap lines</span>
        </Button>
      </div>
      <TerminalPlayback content={replay} wrapLines={wrapLines} />
    </div>
  );
}
