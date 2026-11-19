"use client";

// The pieces of a Connect page step: the card label, the line between the
// cards, and the band that holds the one instruction.

import { ArrowDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/tailwind";

// Same gap between every step.
export const STEP_GAP = 32;

/** The line between the cards, fading in toward the connect card. */
export function Connector() {
  return (
    <div
      aria-hidden
      className="mx-auto w-px bg-linear-to-b from-transparent to-primary"
      style={{ height: STEP_GAP }}
    />
  );
}

/** Names a step on its card's top edge, where the connector arrives. */
export function StepPill({ children }: { children: ReactNode }) {
  return (
    <span className="absolute top-0 left-1/2 z-10 inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-semibold whitespace-nowrap shadow-xs">
      {children}
    </span>
  );
}

export function Band({
  busy,
  dim,
  children,
}: {
  /** Settings are being re-read: hold actions until they land. */
  busy?: boolean;
  /** Connected: the next step is in the card below. */
  dim?: boolean;
  children: ReactNode;
}) {
  // Same accent as the heading's marker.
  return (
    <section
      aria-label="Connect"
      aria-busy={busy}
      inert={busy}
      className={cn(
        "relative rounded-3xl border border-primary/40 bg-card p-5 shadow-sm ring-1 ring-primary/15 transition-[color,background-color,border-color,opacity] duration-300",
        dim && "opacity-50",
      )}
    >
      {children}
    </section>
  );
}

export function StepHeading({ step }: { step: string }) {
  return (
    // Times the fade-in alone: a transition duration would also apply to
    // visibility, so a heading OneOf hides would stay painted over the next.
    <h2
      key={step}
      className="inline-flex items-center gap-2.5 text-sm font-semibold tracking-tight motion-safe:animate-in motion-safe:fade-in motion-safe:animation-duration-300"
    >
      <span
        aria-hidden
        className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground [&_svg]:size-3.5"
      >
        <ArrowDown strokeWidth={2.5} />
      </span>
      {step}
    </h2>
  );
}

export function ChipIcon({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "ok" | "warn" | "block";
}) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg border [&_svg]:size-4",
        tone === "ok"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : tone === "warn"
            ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            : tone === "block"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "bg-muted/50 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
