"use client";

import { ChevronLeft, ChevronRight, SkipBack, SkipForward } from "lucide-react";
import { useMemo, useState } from "react";
import { TerminalPlayback } from "@/components/terminal-playback";
import { indexTerminalRecording } from "@/components/terminal-recording-index";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

/** A terminal recording is a sequence of screens, not just its final buffer. */
export function TerminalRecording({ content }: { content: string }) {
  const positions = useMemo(() => indexTerminalRecording(content), [content]);
  const [fitToWidth, setFitToWidth] = useState(true);
  const [selectedOffset, setSelectedOffset] = useState<number | null>(null);
  const last = positions.length - 1;
  const matchingPosition =
    selectedOffset === null
      ? -1
      : positions.findIndex((offset) => offset >= selectedOffset);
  const position = matchingPosition === -1 ? last : matchingPosition;
  // Older recordings emit their geometry only with the final captured frame.
  // Use that grid for earlier screens too, rather than refitting absolute cursor positions.
  const geometry = useMemo(
    () =>
      Array.from(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: recorded terminal geometry uses OSC and BEL
        content.matchAll(/\x1b\]777;archestra-terminal-size=\d+x\d+\x07/g),
      ).at(-1)?.[0] ?? "",
    [content],
  );
  const replay =
    selectedOffset === null
      ? content
      : geometry + content.slice(0, positions[position]);
  const seek = (next: number) =>
    setSelectedOffset(next >= last ? null : positions[Math.max(0, next)]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-1 text-slate-400">
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
      </div>
      {geometry ? (
        <div className="flex justify-end border-b border-slate-800 px-3 py-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFitToWidth((value) => !value)}
            className="text-slate-400"
          >
            {fitToWidth ? "Actual size" : "Fit width"}
          </Button>
        </div>
      ) : null}
      <TerminalPlayback content={replay} fitToWidth={fitToWidth} />
    </div>
  );
}
