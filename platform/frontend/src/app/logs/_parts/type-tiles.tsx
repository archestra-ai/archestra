"use client";

import { ChevronRight, CircleAlert, ShieldX, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  type LogBucket,
  type LogSource,
  SOURCES,
} from "@/lib/logs/log-events.query";
import { cn } from "@/lib/utils/tailwind";
import { compact, problemWord, SourceTile, Sparkline } from "./tile-bits";
import { MobileTypeTiles } from "./type-tiles-mobile";

/**
 * The type switcher: one tile per log type with its count, its problems and a
 * sparkline. Clicking a tile shows that type; clicking the chosen tile again
 * goes back to every type. One row of five on a wide container; two-line rows
 * (`MobileTypeTiles`) below that.
 */
export function TypeTiles({
  type,
  counts,
  problems,
  buckets,
  problemBuckets,
  loading,
  onPick,
}: {
  type: LogSource | undefined;
  counts: Record<LogSource, number>;
  problems: Record<LogSource, number>;
  buckets?: LogBucket[];
  problemBuckets?: LogBucket[];
  loading: boolean;
  onPick: (type: LogSource | undefined, opts?: { problems?: boolean }) => void;
}) {
  return (
    <>
      {/* Narrow: two-line rows, one per type. */}
      <div className="@3xl:hidden">
        <MobileTypeTiles
          type={type}
          counts={counts}
          problems={problems}
          buckets={buckets}
          problemBuckets={problemBuckets}
          loading={loading}
          onPick={onPick}
        />
      </div>
      {/* Wide: one row of five tiles. */}
      <div className="hidden grid-cols-5 gap-2 pt-0.5 pb-1 @3xl:grid">
        {SOURCES.map((s) => {
          const n = counts[s.id];
          const bad = problems[s.id];
          const selected = type === s.id;
          const dimmed = !!type && !selected;
          return (
            <div
              key={s.id}
              className={cn(
                "group relative rounded-lg border bg-background transition-[border-color,background-color,opacity]",
                selected
                  ? "border-foreground/30 bg-muted/40 ring-1 ring-foreground/10"
                  : "hover:border-foreground/25 hover:bg-muted/30",
                dimmed && "opacity-60 hover:opacity-100",
              )}
            >
              <UnstyledButton
                onClick={() => onPick(selected ? undefined : s.id)}
                aria-pressed={selected}
                aria-label={
                  selected ? "Show every type" : `Show ${s.label} logs`
                }
                className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              <div className="pointer-events-none flex items-center gap-2 px-3 pt-2.5">
                <SourceTile source={s.id} size="xs" />
                <span className="truncate text-xs font-medium">{s.label}</span>
                {selected ? (
                  <X className="ml-auto size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                ) : (
                  <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
                )}
              </div>
              <div className="flex items-end gap-2 px-3 pt-1 pb-2.5">
                <div className="pointer-events-none min-w-0 shrink-0">
                  {loading ? (
                    <Skeleton className="my-1 h-5 w-12" />
                  ) : (
                    <span className="text-xl leading-7 font-semibold tabular-nums">
                      {compact(n)}
                    </span>
                  )}
                  <div className="h-5">
                    {bad > 0 ? (
                      <UnstyledButton
                        onClick={() => onPick(s.id, { problems: true })}
                        title={`Show only ${problemWord(s.id, bad)}`}
                        className={cn(
                          "pointer-events-auto relative -ml-1 inline-flex h-5 items-center gap-1 rounded px-1 text-[11px] font-medium tabular-nums hover:underline",
                          s.id === "guardrails"
                            ? "text-orange-600 dark:text-orange-400"
                            : "text-red-600 dark:text-red-400",
                        )}
                      >
                        {s.id === "guardrails" ? (
                          <ShieldX className="size-3" />
                        ) : (
                          <CircleAlert className="size-3" />
                        )}
                        <span>{problemWord(s.id, bad)}</span>
                      </UnstyledButton>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        {loading ? null : <span>No problems</span>}
                      </span>
                    )}
                  </div>
                </div>
                <Sparkline
                  source={s.id}
                  buckets={buckets}
                  problemBuckets={problemBuckets}
                />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** "All | ● Problems 192": a two-way view switch for the toolbar's end. */
export function ProblemsSwitch({
  on,
  count,
  compact: phone,
  onChange,
}: {
  on: boolean;
  count?: number;
  /** In the funnel popover: full width, 36px. */
  compact: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <fieldset
      aria-label="Show"
      className={cn(
        "m-0 inline-flex h-8 min-w-0 shrink-0 items-center gap-0.5 rounded-md border bg-background p-0.5 text-sm lg:ml-auto",
        phone && "h-9 w-full",
      )}
    >
      {[false, true].map((value) => {
        const pressed = on === value;
        return (
          <UnstyledButton
            key={String(value)}
            aria-pressed={pressed}
            onClick={() => onChange(value)}
            className={cn(
              "flex h-full items-center gap-1.5 rounded-[5px] px-2.5 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              phone && "flex-1 justify-center",
              pressed && "bg-muted font-medium text-foreground shadow-xs",
            )}
          >
            {value ? (
              <>
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    count ? "bg-red-500" : "bg-muted-foreground/40",
                  )}
                />
                Problems
                {count != null && (
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">
                    {count.toLocaleString()}
                  </span>
                )}
              </>
            ) : (
              <span>All</span>
            )}
          </UnstyledButton>
        );
      })}
    </fieldset>
  );
}
