import {
  hasRetainedSessionActivity,
  NO_MODEL_ACTIVITY_WARNING_MS,
} from "@/lib/agent-run-activity";
import type { AgentRunSession } from "@/lib/agent-runtime.query";
import { formatRuntimeDuration } from "@/lib/agent-runtime-time";

/**
 * The one status rule for Agent Runtime runs. The sidebar glyph, the run
 * header pill and the run lists all render from this, so they cannot disagree.
 *
 * - `glyph` answers "is the machine on?": a live, attachable CLI session is
 *   green, one that is coming up pulses, anything you cannot attach to is grey.
 * - `dot` answers "what is the agent doing, and does it need me?": green while
 *   it works unattended, amber when it waits on a person, red when the turn
 *   failed, none when nothing is happening and nothing is asked of you.
 */
type RunStatusMarks = {
  glyph: "booting" | "live" | "off";
  dot: "working" | "attention" | "failed" | null;
  /** Names the machine or the turn: Running, Session open, Completed… */
  label: string;
  /** Muted detail when label and turn outcome differ ("turn completed"). */
  suffix: string | null;
  /** The dot in words, for the header. */
  chip: { tone: "attention" | "failed"; label: string } | null;
  /** Label, suffix and chip on one line for tooltips and accessible names. */
  description: string;
};

export type RunStatusInput = {
  state: AgentRunSession["state"];
  attentionState?: AgentRunSession["attentionState"];
  startedAt?: string;
  endedAt?: string | null;
  hardDeadlineAt?: string;
  lastModelActivityAt?: string | null;
  /** Detail-route facts; the list route does not carry them yet. */
  workspace?: { state: string; terminalAvailable?: boolean } | null;
};

export function runStatusMarks(
  run: RunStatusInput,
  now = Date.now(),
): RunStatusMarks {
  const endedAt = run.endedAt ?? null;
  switch (run.state) {
    case "TASK_STATE_FAILED":
    case "TASK_STATE_REJECTED":
      return marks({
        glyph: "off",
        dot: "failed",
        label: "Ended",
        chip: { tone: "failed", label: "Failed" },
      });
    case "TASK_STATE_CANCELED":
      return marks({ glyph: "off", dot: null, label: "Canceled" });
    case "TASK_STATE_COMPLETED": {
      if (
        hasRetainedSessionActivity(
          {
            state: run.state,
            endedAt,
            lastModelActivityAt: run.lastModelActivityAt ?? null,
          },
          now,
        )
      ) {
        return marks({
          glyph: "live",
          dot: "working",
          label: "Session active",
          suffix: "turn completed",
        });
      }
      if (run.workspace?.terminalAvailable) {
        return marks({
          glyph: "live",
          dot: null,
          label: "Session open",
          suffix: "turn completed",
        });
      }
      return marks({
        glyph: "off",
        dot: null,
        label: "Completed",
        suffix:
          run.workspace?.state === "suspended"
            ? "suspended"
            : run.workspace?.state === "deleted"
              ? "workspace removed"
              : null,
      });
    }
    case "TASK_STATE_SUBMITTED":
    case "TASK_STATE_WORKING":
    case "TASK_STATE_INPUT_REQUIRED":
    case "TASK_STATE_AUTH_REQUIRED": {
      if (
        endedAt === null &&
        run.hardDeadlineAt &&
        new Date(run.hardDeadlineAt).getTime() <= now
      ) {
        return marks({ glyph: "off", dot: null, label: "Stopping" });
      }
      const attention =
        run.attentionState ??
        (run.state === "TASK_STATE_INPUT_REQUIRED"
          ? "input_required"
          : run.state === "TASK_STATE_AUTH_REQUIRED"
            ? "auth_required"
            : null);
      if (attention === "input_required") {
        return marks({
          glyph: "live",
          dot: "attention",
          label: "Running",
          chip: { tone: "attention", label: "Needs your input" },
        });
      }
      if (attention === "auth_required") {
        return marks({
          glyph: "live",
          dot: "attention",
          label: "Running",
          chip: { tone: "attention", label: "Needs sign-in" },
        });
      }
      if (run.state === "TASK_STATE_SUBMITTED") {
        return marks({ glyph: "booting", dot: null, label: "Starting" });
      }
      const quietMs = run.startedAt
        ? now - new Date(run.lastModelActivityAt ?? run.startedAt).getTime()
        : 0;
      return marks({
        glyph: "live",
        dot: "working",
        label: "Running",
        suffix:
          endedAt === null && quietMs >= NO_MODEL_ACTIVITY_WARNING_MS
            ? `quiet for ${formatRuntimeDuration(quietMs)}`
            : null,
      });
    }
    default:
      return marks({ glyph: "booting", dot: null, label: "Pending" });
  }
}

function marks(
  partial: Pick<RunStatusMarks, "glyph" | "dot" | "label"> &
    Partial<Pick<RunStatusMarks, "suffix" | "chip">>,
): RunStatusMarks {
  const suffix = partial.suffix ?? null;
  const chip = partial.chip ?? null;
  return {
    ...partial,
    suffix,
    chip,
    description: [partial.label, suffix, chip?.label]
      .filter(Boolean)
      .join(" · "),
  };
}

/** Machine liveness, as the sidebar glyph's icon colour. */
export const RUN_GLYPH_CLASS: Record<RunStatusMarks["glyph"], string> = {
  booting: "text-emerald-500 animate-pulse motion-reduce:animate-none",
  live: "text-emerald-500",
  off: "text-muted-foreground",
};

/** Machine liveness, as the header pill's inline dot. */
export const RUN_GLYPH_DOT_CLASS: Record<RunStatusMarks["glyph"], string> = {
  booting: "bg-emerald-500 animate-pulse motion-reduce:animate-none",
  live: "bg-emerald-500",
  off: "bg-muted-foreground/50",
};

/**
 * Attention, as a corner dot. Shared with chat sessions so a dot means the
 * same thing in every sidebar row: green is working unattended, amber is
 * waiting on a person, red wants a look.
 */
export const ATTENTION_DOT_CLASS: Record<
  NonNullable<RunStatusMarks["dot"]>,
  string
> = {
  working: "bg-emerald-500",
  attention: "bg-amber-500",
  failed: "bg-destructive",
};

/** Attention, as a header chip. */
export const ATTENTION_CHIP_CLASS: Record<
  NonNullable<RunStatusMarks["chip"]>["tone"],
  string
> = {
  attention:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  failed: "border-destructive/20 bg-destructive/5 text-destructive",
};
