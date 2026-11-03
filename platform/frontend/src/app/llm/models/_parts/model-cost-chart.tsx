"use client";

import { addDays, format } from "date-fns";
import { CalendarIcon, GripVertical } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { DateTimeCalendar } from "@/components/ui/date-time-calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils/tailwind";
import { formatModelCost } from "./model-cost-format";

/** One calendar day of a model's history, at local midnight. */
export interface ChartDay {
  day: Date;
  requests: number;
  recordedCost: number;
  recomputedCost: number;
}

/** `now - ms`, rounded down to the minute so the start reads cleanly. */
export function presetDate(ms: number): Date {
  const date = new Date(Date.now() - ms);
  date.setSeconds(0, 0);
  return date;
}

/**
 * Cost per day: recorded cost as bars, the cost at the prices above as a
 * tick. A draggable handle marks where the recompute starts (click, drag or
 * arrow keys move it); presets and an exact date and time sit on the header
 * line. Days recorded at $0 are flagged, with a one-click start at them.
 */
export function CostChart({
  days,
  since,
  firstRequestAt,
  presetId,
  onPick,
}: {
  /** Every calendar day from the first request to today. */
  days: ChartDay[];
  since: Date;
  firstRequestAt: Date;
  presetId: string | null;
  onPick: (date: Date, preset?: string | null) => void;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const bars = useMemo(() => toBars(days), [days]);
  const zeroWindow = useMemo(() => findZeroCostWindow(days), [days]);
  const n = bars.length;
  const maxCost = Math.max(
    0.000001,
    ...bars.map((bar) => Math.max(bar.recordedCost, bar.recomputedCost)),
  );
  const chartStart = n > 0 ? bars[0].start.getTime() : 0;
  const chartEnd = n > 0 ? bars[n - 1].end.getTime() : 1;

  const sinceMs = since.getTime();
  const isSelected = (bar: Bar) => bar.end.getTime() > sinceMs;
  const sinceIdx =
    n > 0
      ? clamp(
          bars.findIndex((bar) => bar.end.getTime() > sinceMs),
          0,
          n - 1,
        )
      : 0;
  const handlePct =
    clamp((sinceMs - chartStart) / (chartEnd - chartStart), 0, 1) * 100;

  const pickIdx = (idx: number) => {
    const start = bars[idx]?.start;
    if (!start || sinceMs === start.getTime()) return;
    onPick(start);
  };
  const indexAt = (clientX: number): number | null => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || n === 0) return null;
    return clamp(
      Math.floor(((clientX - rect.left) / rect.width) * n),
      0,
      n - 1,
    );
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const idx = indexAt(event.clientX);
    if (idx === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
    pickIdx(idx);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const idx = indexAt(event.clientX);
    if (event.pointerType === "mouse") setHoverIdx(idx);
    if (isDragging && idx !== null) pickIdx(idx);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (n === 0) return;
    // From an exact time inside a day, the first step back is that day's start.
    const atBarStart = bars[sinceIdx]?.start.getTime() === sinceMs;
    const next =
      event.key === "ArrowLeft"
        ? atBarStart
          ? sinceIdx - 1
          : sinceIdx
        : event.key === "ArrowRight"
          ? sinceIdx + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? n - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    pickIdx(clamp(next, 0, n - 1));
  };

  const hovered = hoverIdx !== null && !isDragging ? bars[hoverIdx] : undefined;
  const midBar = n > 0 ? bars[Math.floor(n / 2)] : null;
  const isCustom = presetId === null;
  const presets = [
    ...SINCE_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      date: () => presetDate(preset.ms),
    })),
    { id: "all", label: "All", date: () => firstRequestAt },
  ];

  return (
    <div className="rounded-md border bg-background/60 px-2.5 pt-2 pb-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className="shrink-0 text-[11px] text-muted-foreground">
          Cost per day
        </span>
        <div className="ml-auto inline-flex max-w-full items-center rounded-md border bg-background p-0.5 shadow-xs">
          {presets.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              size="xs"
              variant="ghost"
              aria-label={PRESET_ARIA_LABELS[preset.id]}
              aria-pressed={presetId === preset.id}
              onClick={() => onPick(preset.date(), preset.id)}
              className={cn(
                "tabular-nums",
                presetId === preset.id
                  ? "bg-muted text-foreground hover:bg-muted"
                  : "text-muted-foreground",
              )}
            >
              {preset.label}
            </Button>
          ))}
          <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-label={`Exact start: ${format(since, "MMM d, yyyy, h:mm a")}. Pick a date and time`}
                aria-pressed={isCustom}
                className={cn(
                  "min-w-0 tabular-nums",
                  isCustom || calendarOpen
                    ? "bg-muted text-foreground hover:bg-muted"
                    : "text-muted-foreground",
                )}
              >
                <CalendarIcon className="size-3" aria-hidden />
                <span className="truncate">
                  {format(since, "MMM d")}
                  <span className="hidden min-[420px]:inline">
                    {format(since, ", HH:mm")}
                  </span>
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <DateTimeCalendar
                day={since}
                time={[since.getHours(), since.getMinutes()]}
                disabledDate={(date) => date.getTime() > Date.now()}
                onChange={(date) => onPick(date, null)}
                onDone={() => setCalendarOpen(false)}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label="Recompute from"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, n - 1)}
        aria-valuenow={sinceIdx}
        aria-valuetext={sliderValueText(since, bars[sinceIdx])}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHoverIdx(null)}
        onKeyDown={onKeyDown}
        className={cn(
          "relative touch-pan-y select-none rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          isDragging ? "cursor-grabbing" : "cursor-pointer",
        )}
      >
        {/* Handle rail */}
        <div className="relative h-7">
          <div
            className="absolute top-0"
            style={{
              left: `${handlePct}%`,
              transform: `translateX(-${handlePct}%)`,
            }}
          >
            <div
              className={cn(
                "flex h-6 items-center gap-1 whitespace-nowrap rounded-full border border-foreground bg-foreground pr-2.5 pl-1 text-[11px] font-medium text-background tabular-nums shadow-xs",
                !isDragging && "cursor-grab",
              )}
            >
              <GripVertical className="size-3 opacity-70" aria-hidden />
              {format(since, "MMM d, h:mm a")}
            </div>
          </div>
        </div>

        <div ref={plotRef} className="relative h-28">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 rounded-r-sm bg-primary/5"
            style={{ left: `${handlePct}%` }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-3 border-t border-dashed border-border/70"
          />
          <div className="absolute inset-x-0 top-3 bottom-0 flex items-end gap-px">
            {bars.map((bar, i) => {
              const selected = isSelected(bar);
              const isHover = hoverIdx === i && !isDragging;
              const recordedPct = clamp(
                (bar.recordedCost / maxCost) * 100,
                0,
                100,
              );
              const recomputedPct = clamp(
                (bar.recomputedCost / maxCost) * 100,
                0,
                100,
              );
              return (
                <div
                  key={bar.start.getTime()}
                  className={cn(
                    "relative h-full min-w-0 flex-1 rounded-t-[1px] transition-colors duration-150",
                    isHover && "bg-foreground/5",
                  )}
                >
                  {/* What a $0 day should have cost */}
                  {bar.zero && (
                    <div
                      className={cn(
                        "absolute inset-x-0 bottom-0 transition-colors duration-150",
                        selected
                          ? "bg-primary/15"
                          : "bg-amber-500/15 dark:bg-amber-400/15",
                      )}
                      style={{ height: `${recomputedPct}%` }}
                    />
                  )}
                  <div
                    className={cn(
                      "absolute inset-x-0 bottom-0 rounded-t-[1px] transition-colors duration-150",
                      selected ? "bg-primary/35" : "bg-muted-foreground/25",
                      isHover &&
                        (selected ? "bg-primary/50" : "bg-muted-foreground/40"),
                    )}
                    style={{ height: `${recordedPct}%` }}
                  />
                  {bar.requests > 0 && (
                    <div
                      className={cn(
                        "absolute inset-x-0 h-0.5 rounded-full transition-colors duration-150",
                        selected
                          ? "bg-primary"
                          : bar.zero
                            ? "bg-amber-600 dark:bg-amber-400"
                            : "bg-muted-foreground/60",
                      )}
                      style={{
                        bottom: `max(0px, calc(${recomputedPct}% - 1px))`,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* $0 strip, aligned to the bars */}
        <div aria-hidden className="mt-1 flex h-1 gap-px">
          {bars.map((bar) => (
            <div
              key={bar.start.getTime()}
              className={cn(
                "min-w-0 flex-1 rounded-full",
                bar.zero && "bg-amber-500/80 dark:bg-amber-400/70",
              )}
            />
          ))}
        </div>

        {/* Handle line, from the pill through the $0 strip */}
        <div
          aria-hidden
          className="pointer-events-none absolute top-6 bottom-0 w-0 border-l border-foreground"
          style={{
            left: `${handlePct}%`,
            transform: `translateX(-${handlePct / 100}px)`,
          }}
        />
      </div>

      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{n > 0 ? format(bars[0].start, "MMM d") : null}</span>
        <span>{midBar ? format(midBar.start, "MMM d") : null}</span>
        <span>Today</span>
      </div>

      {/* Legend, replaced by the hovered bar's readout */}
      <div className="mt-1.5 flex min-h-4 items-center text-[11px]">
        {hovered ? (
          <span className="min-w-0 truncate text-muted-foreground tabular-nums">
            <span>{barLabel(hovered)}</span>
            <span>{" · "}</span>
            <span
              className={cn(
                hovered.zero && "text-amber-700 dark:text-amber-400",
              )}
            >
              {formatModelCost(hovered.recordedCost)}
            </span>
            <span>{" → "}</span>
            <span className="text-foreground">
              {formatModelCost(hovered.recomputedCost)}
            </span>
          </span>
        ) : (
          <span className="flex items-center gap-3 text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2.5 w-2 shrink-0 rounded-[1px] bg-muted-foreground/25"
              />
              Recorded
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-0.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/60"
              />
              With the prices above
            </span>
          </span>
        )}
      </div>

      {zeroWindow && (
        <ZeroCostLine
          window={zeroWindow}
          covered={sinceMs <= zeroWindow.from.getTime()}
          onPick={() => onPick(zeroWindow.from, null)}
        />
      )}
    </div>
  );
}

// ===

interface Bar {
  start: Date;
  /** Exclusive. */
  end: Date;
  requests: number;
  recordedCost: number;
  recomputedCost: number;
  /** Requests were made but recorded at $0. */
  zero: boolean;
}

const DAY_MS = 24 * 3600_000;
/** Beyond this many days, bars stand for several days each. */
const MAX_BARS = 120;

const SINCE_PRESETS = [
  { id: "24h", label: "24h", ms: 1 * DAY_MS },
  { id: "7d", label: "7d", ms: 7 * DAY_MS },
  { id: "30d", label: "30d", ms: 30 * DAY_MS },
  { id: "90d", label: "90d", ms: 90 * DAY_MS },
] as const;

const PRESET_ARIA_LABELS: Record<string, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "Since the first request",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** One bar per day, or per few days when the history is long. */
function toBars(days: ChartDay[]): Bar[] {
  const perBar = Math.max(1, Math.ceil(days.length / MAX_BARS));
  const bars: Bar[] = [];
  for (let i = 0; i < days.length; i += perBar) {
    const group = days.slice(i, i + perBar);
    const requests = sum(group, (day) => day.requests);
    const recordedCost = sum(group, (day) => day.recordedCost);
    bars.push({
      start: group[0].day,
      end: addDays(group[group.length - 1].day, 1),
      requests,
      recordedCost,
      recomputedCost: sum(group, (day) => day.recomputedCost),
      zero: requests > 0 && recordedCost === 0,
    });
  }
  return bars;
}

/**
 * The most recent stretch of days whose requests were recorded at $0 but cost
 * something at the prices above: the usual reason to recompute. Days without
 * requests neither break nor extend the stretch.
 */
function findZeroCostWindow(days: ChartDay[]): { from: Date; to: Date } | null {
  let to: Date | null = null;
  let from: Date | null = null;
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    if (day.requests === 0) continue;
    const zero = day.recordedCost === 0 && day.recomputedCost > 0;
    if (zero) {
      to ??= day.day;
      from = day.day;
    } else if (to) {
      break;
    }
  }
  return from && to ? { from, to } : null;
}

function sum(days: ChartDay[], value: (day: ChartDay) => number): number {
  return days.reduce((total, day) => total + value(day), 0);
}

function barLabel(bar: Bar): string {
  const last = new Date(bar.end.getTime() - DAY_MS);
  return last.getTime() === bar.start.getTime()
    ? format(bar.start, "EEE, MMM d")
    : `${format(bar.start, "MMM d")} – ${format(last, "MMM d")}`;
}

function ZeroCostLine({
  window: zeroWindow,
  covered,
  onPick,
}: {
  window: { from: Date; to: Date };
  covered: boolean;
  onPick: () => void;
}) {
  const fromLabel = format(zeroWindow.from, "MMM d");
  const range =
    zeroWindow.from.getTime() === zeroWindow.to.getTime()
      ? fromLabel
      : `${fromLabel} – ${format(zeroWindow.to, "MMM d")}`;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2 text-xs">
      <span
        aria-hidden
        className="h-1 w-4 shrink-0 rounded-full bg-amber-500/80 dark:bg-amber-400/70"
      />
      {covered ? (
        <span className="min-w-0 text-muted-foreground">
          <span className="tabular-nums text-foreground">{range}</span>
          <span> (recorded at $0) are included.</span>
        </span>
      ) : (
        <>
          <span className="min-w-0 text-muted-foreground">
            <span className="tabular-nums text-foreground">{range}</span>
            <span> were recorded at $0.</span>
          </span>
          <Button
            type="button"
            variant="link"
            size="xs"
            className="ml-auto h-auto px-0"
            onClick={onPick}
          >
            Recompute from {fromLabel}
          </Button>
        </>
      )}
    </div>
  );
}

/** What the start slider announces: the start, and its day's cost both ways. */
function sliderValueText(since: Date, bar: Bar | undefined): string {
  const start = format(since, "MMM d, yyyy, h:mm a");
  if (!bar) return start;
  return `${start}. ${barLabel(bar)}: ${formatModelCost(bar.recordedCost)} recorded, ${formatModelCost(bar.recomputedCost)} at the new prices`;
}
