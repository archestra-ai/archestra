"use client";

import type { AgentRunAttachPhase } from "@archestra/shared";
import { Check, CircleAlert, Loader2 } from "lucide-react";
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
          <p className="text-sm font-medium text-slate-100">
            {progress.message}
          </p>
          <span
            role="timer"
            className="shrink-0 font-mono text-xs tabular-nums text-slate-500"
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
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-out"
            style={{ width: `${percent}%` }}
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
              <span
                className={cn(
                  index < activeStep && "text-slate-500",
                  index === activeStep && "text-slate-200",
                  index > activeStep && "text-slate-600",
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
          <p className="truncate font-mono text-[11px] text-slate-600">
            {progress.resourceName}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ===================== internals =====================

function StepIcon({ state }: { state: "done" | "active" | "pending" }) {
  if (state === "done") {
    return <Check className="size-3.5 shrink-0 text-emerald-500" />;
  }
  if (state === "active") {
    return (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-emerald-400" />
    );
  }
  return (
    <span
      className="size-3.5 shrink-0"
      // A dot rather than an outline circle: four ringed placeholders read as
      // checkboxes waiting to be ticked by the reader.
    >
      <span className="mt-[5px] ml-[3px] block size-1.5 rounded-full bg-slate-700" />
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
