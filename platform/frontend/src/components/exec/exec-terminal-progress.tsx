"use client";

import type { AgentRunAttachPhase } from "@archestra/shared";
import { Check, CircleAlert, Info, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** What the terminal knows about an attach that has not completed yet. */
export type ExecSessionProgress = {
  phase: AgentRunAttachPhase;
  message: string;
  detail: string | null;
  resourceName: string | null;
};

/**
 * Startup progress for a background execution's terminal.
 *
 * Replaces an unqualified "Connecting…" that could sit for minutes while a pod
 * was scheduled and its image pulled. Every line here comes from the run's
 * actual runtime state, so a run that is stuck says why it is stuck.
 */
export function ExecTerminalProgress({
  progress,
  startedAt,
}: {
  progress: ExecSessionProgress;
  /** When this attach began, for the elapsed counter. */
  startedAt: number;
}) {
  const elapsed = useElapsedSeconds(startedAt);
  const currentStep = STEPS.findIndex((step) =>
    step.phases.includes(progress.phase),
  );
  // An unrecognized phase from a newer backend should not blank the list.
  const activeStep = currentStep === -1 ? 0 : currentStep;
  // Never reaches 100%: the terminal itself replaces this on success, and a
  // full bar under a spinner reads as a stall.
  const percent = ((activeStep + 1) / (STEPS.length + 1)) * 100;

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          {/* Live region: a screen reader user gets the phase change spoken
              rather than watching a spinner they cannot see. */}
          <output className="text-sm font-medium text-slate-100">
            {progress.message}
          </output>
          {/* `role="timer"` is implicitly aria-live="off", so a counter that
              ticks every second never interrupts the region above. */}
          <span
            role="timer"
            className="shrink-0 font-mono text-xs tabular-nums text-slate-400"
            aria-label="Time spent starting"
          >
            {formatElapsed(elapsed)}
          </span>
        </div>

        <div
          className="h-1 w-full overflow-hidden rounded-full bg-slate-800"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={STEPS.length}
          aria-valuenow={activeStep + 1}
          aria-valuetext={progress.message}
        >
          {/* Scale, not width: animating width relayouts the panel every
              frame, while a transform stays on the compositor. */}
          <div
            className="h-full w-full origin-left rounded-full bg-emerald-500 transition-transform duration-500 ease-out motion-reduce:transition-none"
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        </div>

        <ol className="space-y-1.5">
          {STEPS.map((step, index) => (
            <li
              key={step.label}
              className="flex items-center gap-2 text-xs"
              aria-current={index === activeStep ? "step" : undefined}
            >
              <StepIcon
                state={
                  index < activeStep
                    ? "done"
                    : index === activeStep
                      ? "active"
                      : "pending"
                }
              />
              {/* Only two text tiers: slate-500/600 measure 4.2:1 and 2.7:1 on
                  this panel, both under WCAG AA. The icon carries done vs
                  pending, so the label does not have to dim below legibility. */}
              <span
                className={cn(
                  index === activeStep ? "text-slate-100" : "text-slate-400",
                )}
              >
                {step.label}
              </span>
            </li>
          ))}
        </ol>

        {progress.detail ? (
          <div className="flex gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5">
            <CircleAlert className="mt-px size-3.5 shrink-0 text-amber-400" />
            <p className="break-words font-mono text-[11px] leading-relaxed text-amber-200/90">
              {progress.detail}
            </p>
          </div>
        ) : null}

        {progress.resourceName ? (
          <p className="truncate font-mono text-[11px] text-slate-400">
            {progress.resourceName}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A terminal-sized status for waits, errors, and informational notices. */
export function ExecTerminalStatus({
  title,
  detail,
  tone = "info",
  compact = false,
}: {
  title: string;
  detail?: string | null;
  tone?: "info" | "loading" | "warning" | "error";
  compact?: boolean;
}) {
  const Icon =
    tone === "loading"
      ? Loader2
      : tone === "error"
        ? CircleAlert
        : tone === "warning"
          ? TriangleAlert
          : Info;

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center p-6",
        compact && "flex-none p-4",
      )}
    >
      <div
        className={cn(
          "flex w-full max-w-sm flex-col items-center gap-3 text-center",
          compact && "max-w-xl flex-row text-left",
        )}
      >
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg border bg-slate-900",
            tone === "error" && "border-red-400/20 text-red-400",
            tone === "warning" && "border-amber-400/20 text-amber-400",
            (tone === "info" || tone === "loading") &&
              "border-slate-800 text-slate-300",
          )}
        >
          <Icon
            className={cn(
              "size-4",
              tone === "loading" && "animate-spin motion-reduce:animate-none",
            )}
          />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-slate-100">{title}</p>
          {detail ? (
            <p className="break-words text-xs leading-relaxed text-slate-400">
              {detail}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ===================== internals =====================

/**
 * The waits an attach goes through, as a person would describe them.
 *
 * Several protocol phases collapse into one step: "queued" and "scheduling"
 * are both "we do not have a machine yet", and splitting them would show a
 * step that ticks over without anything having visibly happened.
 */
const STEPS: { label: string; phases: AgentRunAttachPhase[] }[] = [
  { label: "Scheduling onto a node", phases: ["queued", "scheduling"] },
  { label: "Pulling the agent image", phases: ["pulling"] },
  { label: "Starting the agent session", phases: ["starting"] },
  { label: "Opening the terminal", phases: ["attaching"] },
];

function StepIcon({ state }: { state: "done" | "active" | "pending" }) {
  if (state === "done") {
    return <Check className="size-3.5 shrink-0 text-emerald-500" />;
  }
  if (state === "active") {
    // The one animation on this panel, so it is also the one that has to stop
    // for readers who ask motion to stop (WCAG 2.3.3).
    return (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-emerald-400 motion-reduce:animate-none" />
    );
  }
  return (
    <span
      className="size-3.5 shrink-0"
      // A dot rather than an outline circle: four ringed placeholders read as
      // checkboxes waiting to be ticked by the reader.
    >
      <span className="mt-[5px] ml-[3px] block size-1.5 rounded-full bg-slate-500" />
    </span>
  );
}

function useElapsedSeconds(startedAt: number): number {
  const [elapsed, setElapsed] = useState(() =>
    Math.floor((Date.now() - startedAt) / 1000),
  );

  useEffect(() => {
    setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  return elapsed;
}

function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
