"use client";

import { ChevronRight, CircleAlert, ShieldX, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  type LogBucket,
  type LogSource,
  SOURCE_BY_ID,
  SOURCES,
} from "@/lib/logs/log-events.query";
import { cn } from "@/lib/utils/tailwind";
import { compact, problemWord, SourceTile, Sparkline } from "./tile-bits";

interface MobileTilesProps {
  type: LogSource | undefined;
  counts: Record<LogSource, number>;
  problems: Record<LogSource, number>;
  buckets?: LogBucket[];
  problemBuckets?: LogBucket[];
  loading: boolean;
  onPick: (type: LogSource | undefined, opts?: { problems?: boolean }) => void;
}

/**
 * Below the wide tile row: every type as a two-line row, so no name or
 * number is cut. Tapping a row picks its type; tapping it again goes back
 * to every type.
 */
export function MobileTypeTiles(props: MobileTilesProps) {
  return (
    <div className="divide-y overflow-hidden rounded-lg border bg-background">
      {SOURCES.map((s) => (
        <TwoLineRow key={s.id} s={s.id} {...props} />
      ))}
    </div>
  );
}

function TwoLineRow({
  s,
  type,
  counts,
  problems,
  buckets,
  problemBuckets,
  loading,
  onPick,
}: MobileTilesProps & { s: LogSource }) {
  const selected = type === s;
  return (
    <div
      className={cn(
        "group relative px-3 py-2 transition-[background-color,opacity]",
        selected ? "bg-muted/60" : "hover:bg-muted/30",
        !!type && !selected && "opacity-60",
      )}
    >
      <PickArea s={s} selected={selected} onPick={onPick} />
      <div className="pointer-events-none flex items-center gap-2.5">
        <SourceTile source={s} size="xs" />
        <span className="min-w-0 truncate text-sm font-medium">
          {SOURCE_BY_ID[s].label}
        </span>
        <span className="ml-auto text-base font-semibold tabular-nums">
          <Count n={counts[s]} loading={loading} />
        </span>
        <Affordance selected={selected} />
      </div>
      <div className="mt-0.5 flex h-5 items-center gap-3 pl-[1.875rem]">
        {problems[s] > 0 ? (
          <ProblemLink
            s={s}
            n={problems[s]}
            onPick={onPick}
            className="-ml-1"
          />
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {loading ? null : <span>No problems</span>}
          </span>
        )}
        <Sparkline
          source={s}
          buckets={buckets}
          problemBuckets={problemBuckets}
          className="ml-auto h-4 w-24 flex-none"
        />
        <span className="w-3.5 shrink-0" />
      </div>
    </div>
  );
}

// ===== shared bits =====

/** The whole row picks its type; a second tap goes back to every type. */
function PickArea({
  s,
  selected,
  onPick,
  className,
}: {
  s: LogSource;
  selected: boolean;
  onPick: MobileTilesProps["onPick"];
  className?: string;
}) {
  return (
    <UnstyledButton
      onClick={() => onPick(selected ? undefined : s)}
      aria-pressed={selected}
      aria-label={
        selected ? "Show every type" : `Show ${SOURCE_BY_ID[s].label} logs`
      }
      className={cn(
        "absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
        className,
      )}
    />
  );
}

function ProblemLink({
  s,
  n,
  onPick,
  className,
}: {
  s: LogSource;
  n: number;
  onPick: MobileTilesProps["onPick"];
  className?: string;
}) {
  if (!n) return null;
  return (
    <UnstyledButton
      onClick={() => onPick(s, { problems: true })}
      title={`Show only ${problemWord(s, n)}`}
      className={cn(
        "relative inline-flex h-6 shrink-0 items-center gap-1 rounded px-1 text-[11px] font-medium whitespace-nowrap tabular-nums",
        s === "guardrails"
          ? "text-orange-600 dark:text-orange-400"
          : "text-red-600 dark:text-red-400",
        className,
      )}
    >
      {s === "guardrails" ? (
        <ShieldX className="size-3" />
      ) : (
        <CircleAlert className="size-3" />
      )}
      {problemWord(s, n)}
    </UnstyledButton>
  );
}

function Count({ n, loading }: { n: number; loading: boolean }) {
  return loading ? (
    <Skeleton className="ml-auto inline-block h-4 w-8" />
  ) : (
    <span>{compact(n)}</span>
  );
}

function Affordance({ selected }: { selected: boolean }) {
  return selected ? (
    <X className="pointer-events-none size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    <ChevronRight className="pointer-events-none size-3.5 shrink-0 text-muted-foreground/60" />
  );
}
