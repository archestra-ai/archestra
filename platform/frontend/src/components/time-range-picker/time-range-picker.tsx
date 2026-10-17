"use client";

import {
  CalendarIcon,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Search,
  X,
  ZoomOut,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { DateTimeCalendar } from "@/components/ui/date-time-calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils/tailwind";
import {
  ALL_TIME_RANGE,
  describeResolvedTimeRange,
  describeTimeRange,
  describeTimezone,
  isAllTime,
  isRelativeTimeRange,
  parseTimeExpression,
  QUICK_RANGES,
  type QuickRange,
  resolveTimeRange,
  shiftTimeRange,
  type TimeRange,
  toExact,
  zoomOutTimeRange,
} from "./time-range";

/**
 * The time range control for every page that filters by time: a button that
 * names the range, arrows that move it one span back or forward, a zoom-out
 * that doubles it, and a panel with a typed From and To on one side and quick
 * ranges on the other. Ends are typed as exact times ("2026-10-13 14:30") or
 * relative to now ("now-6h").
 */
export function TimeRangePicker({
  value,
  onChange,
  placeholder = "Any time",
  allowAllTime = false,
  onClear,
  className,
}: {
  /** null when the page is not filtering by time. */
  value: TimeRange | null;
  onChange: (range: TimeRange) => void;
  /** The button's label while `value` is null. */
  placeholder?: string;
  /** Offer "All time" as a quick range, for pages whose data allows it. */
  allowAllTime?: boolean;
  /**
   * Back to `placeholder`'s range. When given, a reset button ends the group,
   * greyed out while there is nothing to reset.
   */
  onClear?: () => void;
  className?: string;
}) {
  const now = useNow(value !== null && isRelativeTimeRange(value));
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value?.from ?? "now-6h");
  const [to, setTo] = useState(value?.to ?? "now");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<TimeRange[]>([]);
  const fromId = useId();
  const toId = useId();

  // The panel opens on the applied range, not on what was typed and dropped.
  useEffect(() => {
    if (!open) return;
    setFrom(value && !isAllTime(value) ? toTyped(value.from) : "now-6h");
    setTo(value && !isAllTime(value) ? toTyped(value.to) : "now");
    setError(null);
    setQuery("");
    setRecent(readRecentRanges());
  }, [open, value]);

  const apply = ({ from, to }: TimeRange) => {
    onChange({ from, to });
    rememberRange({ from, to });
    setOpen(false);
  };

  const applyTyped = (event: FormEvent) => {
    event.preventDefault();
    const start = parseTimeExpression(from, new Date());
    const end = parseTimeExpression(to, new Date());
    if (!start) return setError("From is not a date or a time like now-6h.");
    if (!end) return setError("To is not a date or a time like now.");
    if (end <= start) return setError("To must come after From.");
    apply({ from: from.trim(), to: to.trim() });
  };

  const quickRanges = allowAllTime
    ? [...QUICK_RANGES, { ...ALL_TIME_RANGE, label: "All time" }]
    : QUICK_RANGES;
  const needle = query.trim().toLowerCase();
  const shownRanges = needle
    ? quickRanges.filter((range) => range.label.toLowerCase().includes(needle))
    : quickRanges;
  const label = value ? describeTimeRange(value, now) : placeholder;
  const exactTimes =
    value && !isAllTime(value) ? describeResolvedTimeRange(value, now) : "";
  const canMove = value !== null && !isAllTime(value);
  // Moving forward from a range that already ends now goes nowhere.
  const resolvedEnd = canMove ? resolveTimeRange(value, now)?.end : undefined;
  const canMoveLater =
    canMove && resolvedEnd !== undefined && resolvedEnd < now;

  return (
    // Sized and styled like the filter chips beside it (filterControlClass),
    // and never squeezed by a crowded bar: a cut-off range name or a lost
    // arrow is worse than the bar wrapping.
    <div
      className={cn(
        "flex h-8 shrink-0 items-stretch overflow-hidden rounded-md border border-input text-sm",
        className,
      )}
    >
      <IconButton
        label="Move range earlier"
        disabled={!canMove}
        onClick={() => {
          const earlier = value && shiftTimeRange(value, -1, now);
          if (earlier) onChange(earlier);
        }}
        className="border-r border-inherit max-sm:hidden"
      >
        <ChevronLeft />
      </IconButton>
      <Popover open={open} onOpenChange={setOpen}>
        {/* The range's exact times show on hover, not inline, so they never
              crowd the bar or widen the button. */}
        <Tooltip open={exactTimes && !open ? undefined : false}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                // Grows to fill the group when it is laid out full width (the
                // compact filter popover), so it reads like the selects there.
                className={cn(
                  "h-full min-w-0 flex-1 justify-start gap-1.5 rounded-none px-2.5 text-sm font-normal has-[>svg]:px-2.5 hover:bg-black/5",
                  value !== null && "font-medium",
                )}
              >
                <Clock className="size-3.5 shrink-0 text-muted-foreground" />
                {/* Fit preset labels closely; cap long custom ranges and show
                    their exact times in the tooltip. */}
                <span className="max-w-52 truncate text-left">{label}</span>
                <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{exactTimes}</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          sideOffset={8}
          collisionPadding={24}
          // Capped to the space Radix finds on screen and scrollable, so on a
          // phone the presets stay reachable instead of running off the page.
          className="max-h-[var(--radix-popover-content-available-height)] w-[min(32rem,calc(100vw-3rem))] overflow-y-auto p-0"
        >
          <div className="grid sm:grid-cols-[minmax(0,1fr)_12rem]">
            <form
              onSubmit={applyTyped}
              className="flex flex-col gap-3 p-4"
              aria-label="Time range"
            >
              <p className="text-sm font-semibold">Time range</p>
              <RangeEndField
                id={fromId}
                label="From"
                value={from}
                onChange={(text) => {
                  setFrom(text);
                  setError(null);
                }}
                defaultTime={[0, 0]}
              />
              <RangeEndField
                id={toId}
                label="To"
                value={to}
                onChange={(text) => {
                  setTo(text);
                  setError(null);
                }}
                defaultTime={[23, 59]}
              />
              <p
                className={cn(
                  "text-xs",
                  error ? "text-destructive" : "text-muted-foreground",
                )}
                role={error ? "alert" : undefined}
              >
                {error ??
                  "A date like 2026-10-13 14:30, or now, now-6h, now-7d."}
              </p>
              <Button type="submit" size="sm" className="self-start">
                Apply time range
              </Button>
              {recent.length > 0 && (
                <div className="flex flex-col gap-1 border-t pt-3">
                  <p className="text-xs text-muted-foreground">Recently used</p>
                  {recent.map((range) => (
                    <Button
                      key={`${range.from}|${range.to}`}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 justify-start px-2 font-mono text-xs font-normal"
                      onClick={() => apply(range)}
                    >
                      {range.from} → {range.to}
                    </Button>
                  ))}
                </div>
              )}
            </form>
            <nav
              aria-label="Quick ranges"
              className="flex flex-col gap-2 border-t bg-muted/30 p-2 sm:border-t-0 sm:border-l"
            >
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search presets"
                  aria-label="Search quick ranges"
                  className="h-8 pl-8 text-sm"
                />
              </div>
              <ul className="flex max-h-64 flex-col overflow-y-auto">
                {shownRanges.map((range) => (
                  <li key={range.label}>
                    <QuickRangeButton
                      range={range}
                      selected={
                        value !== null &&
                        value.from.trim() === range.from &&
                        value.to.trim() === range.to
                      }
                      onPick={() => apply(range)}
                    />
                  </li>
                ))}
                {shownRanges.length === 0 && (
                  <li className="px-2 py-3 text-xs text-muted-foreground">
                    No quick range matches.
                  </li>
                )}
              </ul>
            </nav>
          </div>
          <p className="border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
            Browser time · {describeTimezone(now)}
          </p>
        </PopoverContent>
      </Popover>
      <IconButton
        label="Move range later"
        disabled={!canMoveLater}
        onClick={() => {
          const later = value && shiftTimeRange(value, 1, now);
          if (later) onChange(later);
        }}
        className="border-l border-inherit max-sm:hidden"
      >
        <ChevronRight />
      </IconButton>
      <IconButton
        label="Zoom out time range"
        disabled={!canMove}
        onClick={() => {
          const wider = value && zoomOutTimeRange(value, now);
          if (wider) onChange(wider);
        }}
        className="border-l border-inherit max-sm:hidden"
      >
        <ZoomOut />
      </IconButton>
      {/* Always drawn, greyed out with nothing to reset, so setting or
          clearing a range never changes the picker's width. */}
      {onClear && (
        <IconButton
          label="Reset time range"
          disabled={value === null}
          onClick={onClear}
          className="border-l border-inherit max-sm:hidden"
        >
          <X />
        </IconButton>
      )}
    </div>
  );
}

// ===

function RangeEndField({
  id,
  label,
  value,
  onChange,
  defaultTime,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (text: string) => void;
  /** Hour and minute a calendar pick gets when the field has no time yet. */
  defaultTime: [number, number];
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const current = parseTimeExpression(value, new Date());
  // An exact end keeps its time; a relative or empty one starts from the
  // start or end of the day.
  const time: [number, number] =
    current && !value.trim().startsWith("now")
      ? [current.getHours(), current.getMinutes()]
      : defaultTime;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="pr-9 font-mono text-sm"
        />
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Pick ${label.toLowerCase()} date and time`}
              className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
            >
              <CalendarIcon className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <DateTimeCalendar
              day={current}
              time={time}
              disabledDate={(date) => date > new Date()}
              onChange={(date) => onChange(toExact(date))}
              onDone={() => setCalendarOpen(false)}
            />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function QuickRangeButton({
  range,
  selected,
  onPick,
}: {
  range: QuickRange;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        "h-8 w-full justify-start px-2 font-normal",
        selected && "bg-accent font-medium text-accent-foreground",
      )}
    >
      {range.label}
    </Button>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  className,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "h-full w-7 rounded-none text-muted-foreground hover:bg-black/5 [&_svg]:size-3.5",
            className,
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The current minute, ticking while a relative range is shown so its label
 * and exact times stay true.
 */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

function readRecentRanges(): TimeRange[] {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(RECENT_STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(stored)
      ? stored
          .filter(
            (range): range is TimeRange =>
              typeof range?.from === "string" && typeof range?.to === "string",
          )
          .slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

// Only typed ranges are worth remembering; a quick range is one click anyway.
function rememberRange(range: TimeRange) {
  if (
    isAllTime(range) ||
    QUICK_RANGES.some(
      (quick) => quick.from === range.from && quick.to === range.to,
    )
  ) {
    return;
  }
  try {
    const next = [
      range,
      ...readRecentRanges().filter(
        (stored) => stored.from !== range.from || stored.to !== range.to,
      ),
    ].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable (private mode); nothing is remembered then.
  }
}

// A stored ISO timestamp shows in the field as people type one; relative and
// already-typed ends show as they are.
function toTyped(end: string) {
  if (!end.includes("T")) return end;
  const date = parseTimeExpression(end, new Date());
  return date ? toExact(date) : end;
}

const RECENT_STORAGE_KEY = "archestra-recent-time-ranges";
const RECENT_LIMIT = 4;
