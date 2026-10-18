"use client";
// The agent's yells in the session trace. A yell's row carries a faint wash
// and a rail in its colour (amber for a yell, rose for a superyell); from a
// superyell on, the label gutter becomes a rose-striped "guardrails off" band.
// The guardrails bar steps through the page's yells.

import {
  Check,
  ChevronLeft,
  ChevronRight,
  Megaphone,
  MessageCircle,
  ShieldOff,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useYellInvestigation } from "@/app/openappa/_parts/use-yell-investigation";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import type { TraceYell } from "./guardrails";
import { OverviewSection } from "./overview-parts";

/** "Yell" or "Superyell", beside the yell call's name. */
export function YellChip({ yell }: { yell: TraceYell }) {
  const Icon = yell.superyell ? ShieldOff : Megaphone;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 text-[10px] leading-4 font-medium",
        toneOf(yell).chip,
      )}
    >
      <Icon className="size-2.5" aria-hidden="true" />
      {yell.superyell ? "Superyell" : "Yell"}
    </span>
  );
}

/**
 * A row's yell marks, drawn over its `<li>`: the wash and rail of a yell's own
 * row, and the "guardrails off" band over the gutter from the superyell on.
 */
export function YellRowMarks({
  yell,
  off,
  guardrailsOffAt,
  hasGutter,
  selected,
  onSelectRow,
}: {
  /** The yell this row's call sent, if any. */
  yell: TraceYell | null;
  /** Guardrails were off for this row. */
  off: boolean;
  guardrailsOffAt: number | null;
  hasGutter: boolean;
  selected: boolean;
  onSelectRow: () => void;
}) {
  const tone = yell ? toneOf(yell) : null;
  const startsOff = Boolean(yell?.superyell) && yell?.at === guardrailsOffAt;
  return (
    <>
      {tone ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 right-0",
            tone.wash,
          )}
          // Past the 8px gutter; the rail steps aside for the selection edge.
          style={{ left: hasGutter || off ? 8 : 0 }}
        >
          <span
            className={cn("absolute inset-y-0 w-0.5", tone.rail)}
            style={{ left: selected ? 2 : 0 }}
          />
        </span>
      ) : null}
      {off && guardrailsOffAt !== null ? (
        <OffBand
          at={guardrailsOffAt}
          cap={startsOff}
          onSelectRow={onSelectRow}
        />
      ) : null}
    </>
  );
}

/** "‹ 1/2 yells | 1 super ›": steps through the page's yells, selecting each call. */
export function YellStepper({
  yells,
  selectedKey,
  onSelect,
}: {
  /** The page's yells whose calls are on it, oldest first. */
  yells: TraceYell[];
  selectedKey: string | null;
  onSelect: (yell: TraceYell) => void;
}) {
  const active = yells.findIndex((yell) => yell.toolCallKey === selectedKey);
  const supers = yells.filter((yell) => yell.superyell).length;
  const plain = yells.length - supers;
  const current = active >= 0 ? yells[active] : null;
  const step = (delta: number) => {
    const from = active < 0 ? (delta > 0 ? -1 : 0) : active;
    onSelect(yells[(from + delta + yells.length) % yells.length]);
  };
  const dot = current
    ? toneOf(current).dot
    : supers > 0
      ? TONES.super.dot
      : TONES.yell.dot;
  const counts = `${plain} ${plain === 1 ? "yell" : "yells"}${supers > 0 ? `, ${supers} ${supers === 1 ? "superyell" : "superyells"} that turned guardrails off` : ""}`;

  return (
    <span className="inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border bg-card text-foreground/85 lg:h-6">
      <UnstyledButton
        aria-label="Previous yell"
        onClick={() => step(-1)}
        className={ARROW}
      >
        <ChevronLeft className="size-3.5" aria-hidden="true" />
      </UnstyledButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            onClick={() => onSelect(yells[Math.max(0, active)])}
            aria-label={`${counts}${current ? `; ${active + 1} of ${yells.length} selected` : ""}. Select its call.`}
            className="inline-flex cursor-pointer items-center gap-1 border-x px-1.5 font-medium whitespace-nowrap tabular-nums outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
          >
            <span
              aria-hidden="true"
              className={cn("size-1.5 shrink-0 rounded-full", dot)}
            />
            <span aria-hidden="true">
              {current ? (
                <>
                  <span className={cn(current.superyell && TONES.super.text)}>
                    {active + 1}
                  </span>
                  <span className="text-muted-foreground">/{yells.length}</span>
                </>
              ) : (
                yells.length
              )}{" "}
              {yells.length === 1 ? "yell" : "yells"}
            </span>
            {supers > 0 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "inline-flex items-center gap-0.5 border-l pl-1.5",
                  TONES.super.text,
                )}
              >
                <ShieldOff className="size-3" aria-hidden="true" />
                {supers}
                <span className="max-lg:hidden"> super</span>
              </span>
            ) : null}
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-xs">
          <ol className="space-y-1">
            {yells.map((yell, index) => (
              <li
                key={yell.key}
                className={cn(index === active ? "font-medium" : "opacity-80")}
              >
                <span className="tabular-nums">
                  {index + 1}. {yell.superyell ? "Superyell" : "Yell"} ·{" "}
                  {clock(yell.at)}
                </span>
                <span className="block truncate opacity-70">
                  {yell.message}
                </span>
                {yell.superyell ? (
                  <span className="block opacity-90">
                    Guardrails off from here
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </TooltipContent>
      </Tooltip>
      <UnstyledButton
        aria-label="Next yell"
        onClick={() => step(1)}
        className={ARROW}
      >
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </UnstyledButton>
    </span>
  );
}

/** The yell a selected call sent: its message, status and where to follow up. */
export function YellDetails({ yell }: { yell: TraceYell }) {
  const tone = toneOf(yell);
  const Icon = yell.superyell ? ShieldOff : Megaphone;
  return (
    <OverviewSection>
      <div className="flex items-center gap-1.5 text-xs">
        <Icon
          className={cn("size-3.5 shrink-0", tone.text)}
          aria-hidden="true"
        />
        <span className={cn("font-medium", tone.text)}>
          {yell.superyell ? "Superyell" : "Yell"}
        </span>
        <span className="text-muted-foreground">
          {yell.superyell ? "· guardrails turned off" : "· feedback to admins"}
        </span>
        <time
          dateTime={new Date(yell.at).toISOString()}
          className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums"
        >
          {clock(yell.at)}
        </time>
      </div>
      {yell.superyell ? (
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
          Sent with break the glass on. Nothing after it was checked, and the
          label stopped being tracked.
        </p>
      ) : null}
      <blockquote className="mt-2 rounded-md border bg-muted/40 px-2.5 py-2 text-xs leading-[18px] break-words whitespace-pre-wrap text-foreground/90">
        {yell.message}
      </blockquote>
      <dl className="mt-2 grid grid-cols-3 divide-x overflow-hidden rounded-md border text-[11px]">
        <Fact label="Status">
          {yell.resolvedAt ? (
            <span
              className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"
              title={`Resolved ${formatDate({ date: yell.resolvedAt })}`}
            >
              <Check className="size-3" aria-hidden="true" />
              Resolved
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <span
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", tone.dot)}
              />
              Open
            </span>
          )}
        </Fact>
        <Fact label="Archive">
          {yell.hasArchive ? (
            <span>{yell.withTrajectory ? "With trace" : "Included"}</span>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </Fact>
        <Fact label="Chat">
          {yell.conversationId ? (
            <Link
              href={`/chat/${yell.conversationId}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              Open
              <span className="sr-only"> investigation chat</span>
            </Link>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </Fact>
      </dl>
      <InvestigateLink yell={yell} />
    </OverviewSection>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * The gutter once guardrails are off: rose stripes, opposite-handed to the
 * label gutter's narrowed stripes so the two never read alike.
 */
function OffBand({
  at,
  cap,
  onSelectRow,
}: {
  at: number;
  /** The superyell's own row: a cap marks where the band begins. */
  cap: boolean;
  onSelectRow: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Selects the row under it, like the label gutter. */}
        <UnstyledButton
          tabIndex={-1}
          aria-hidden="true"
          onClick={onSelectRow}
          className="absolute inset-y-0 left-0 z-[3] w-2 cursor-pointer bg-card"
        >
          <span
            className="absolute inset-0 bg-rose-500/12 [--off-stripe:rgb(244_63_94/0.55)] dark:bg-rose-400/12 dark:[--off-stripe:rgb(251_113_133/0.55)]"
            style={OFF_STRIPES}
          />
          <span className="absolute inset-y-0 right-0 w-px bg-rose-500/50 dark:bg-rose-400/45" />
          {cap ? (
            <span className="absolute inset-x-0 top-0 h-0.5 bg-rose-600 dark:bg-rose-400" />
          ) : null}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        <p className="font-medium">Guardrails off</p>
        <p className="opacity-70">
          Since the superyell at {clock(at)}: calls were not checked and the
          label was not tracked.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/** Investigates the yell in chat, as the Yells table does. */
function InvestigateLink({ yell }: { yell: TraceYell }) {
  const investigation = useYellInvestigation(yell);
  const { data: allowed } = useHasPermissions(investigation.permissions);
  if (!allowed) return null;
  return (
    <UnstyledButton
      onClick={investigation.launch}
      disabled={investigation.disabled}
      className="mt-2 inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default disabled:opacity-60"
    >
      <MessageCircle className="size-3.5" aria-hidden="true" />
      {investigation.label}
    </UnstyledButton>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 px-2 py-1.5">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{children}</dd>
    </div>
  );
}

function toneOf(yell: TraceYell) {
  return yell.superyell ? TONES.super : TONES.yell;
}

function clock(ms: number) {
  return formatDate({
    date: new Date(ms).toISOString(),
    dateFormat: "HH:mm:ss",
  });
}

const ARROW =
  "flex w-7 shrink-0 cursor-pointer items-center justify-center outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset lg:w-6";

const TONES = {
  yell: {
    chip: "bg-amber-500/12 text-amber-800 dark:bg-amber-400/12 dark:text-amber-300",
    wash: "bg-amber-500/[0.05] dark:bg-amber-400/[0.05]",
    rail: "bg-amber-500/80 dark:bg-amber-400/70",
    dot: "bg-amber-500 dark:bg-amber-400",
    text: "text-amber-700 dark:text-amber-300",
  },
  super: {
    chip: "bg-rose-500/12 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
    wash: "bg-rose-500/[0.06] dark:bg-rose-400/[0.07]",
    rail: "bg-rose-600 dark:bg-rose-400",
    dot: "bg-rose-600 dark:bg-rose-400",
    text: "text-rose-700 dark:text-rose-300",
  },
};

const OFF_STRIPES = {
  backgroundImage:
    "linear-gradient(45deg, var(--off-stripe) 25%, transparent 25%, transparent 50%, var(--off-stripe) 50%, var(--off-stripe) 75%, transparent 75%, transparent)",
  backgroundSize: "8px 8px",
};
