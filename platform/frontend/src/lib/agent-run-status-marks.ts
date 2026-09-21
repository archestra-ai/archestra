import type { archestraApiTypes } from "@archestra/shared";
import {
  hasNoRecentModelActivity,
  modelActivityBaseline,
} from "@/components/agent-run-liveness";
import { hasRetainedSessionActivity } from "@/lib/agent-run-activity";
import type { AgentRunSession } from "@/lib/agent-runtime.query";
import { formatRuntimeDuration } from "@/lib/agent-runtime-time";

type RunStatusMarks = {
  glyph: "booting" | "live" | "off";
  dot: "working" | "attention" | "failed" | null;
  label: string;
  suffix: string | null;
  chip: { tone: "attention" | "failed"; label: string } | null;
  description: string;
};

type WorkspaceState = NonNullable<
  archestraApiTypes.GetMyAgentRunResponses["200"]["workspace"]
>["state"];

export type RunStatusInput = Pick<AgentRunSession, "state"> &
  Partial<
    Pick<
      AgentRunSession,
      | "attentionState"
      | "startedAt"
      | "endedAt"
      | "hardDeadlineAt"
      | "lastModelActivityAt"
      | "terminalRetained"
    >
  > & { workspace?: { state: WorkspaceState } | null };

export function runStatusMarks(
  run: RunStatusInput,
  now = Date.now(),
): RunStatusMarks {
  const endedAt = run.endedAt ?? null;
  const lastModelActivityAt = run.lastModelActivityAt ?? null;
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
          { state: run.state, endedAt, lastModelActivityAt },
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
      if (run.terminalRetained) {
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
        suffix: run.workspace
          ? (WORKSPACE_SUFFIX[run.workspace.state] ?? null)
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
      const attention = run.attentionState ?? ATTENTION_TASK_STATE[run.state];
      if (attention) {
        return marks({
          glyph: "live",
          dot: "attention",
          label: "Running",
          chip: { tone: "attention", label: ATTENTION_CHIP_LABEL[attention] },
        });
      }
      if (run.state === "TASK_STATE_SUBMITTED") {
        return marks({ glyph: "booting", dot: null, label: "Starting" });
      }
      if (
        run.startedAt !== undefined &&
        hasNoRecentModelActivity(
          {
            state: run.state,
            startedAt: run.startedAt,
            endedAt,
            lastModelActivityAt,
          },
          now,
        )
      ) {
        const quietFor = formatRuntimeDuration(
          now -
            modelActivityBaseline({
              startedAt: run.startedAt,
              lastModelActivityAt,
            }).getTime(),
        );
        return marks({
          glyph: "live",
          dot: "working",
          label: "Running",
          suffix: `quiet for ${quietFor}`,
        });
      }
      return marks({ glyph: "live", dot: "working", label: "Running" });
    }
    default:
      return marks({ glyph: "booting", dot: null, label: "Pending" });
  }
}

export const GLYPH_CLASS: Record<
  RunStatusMarks["glyph"],
  { text: string; dot: string }
> = {
  booting: {
    text: "text-emerald-500 animate-pulse motion-reduce:animate-none",
    dot: "bg-emerald-500 animate-pulse motion-reduce:animate-none",
  },
  live: { text: "text-emerald-500", dot: "bg-emerald-500" },
  off: { text: "text-muted-foreground", dot: "bg-muted-foreground/50" },
};

export const ATTENTION_DOT_CLASS: Record<
  NonNullable<RunStatusMarks["dot"]>,
  string
> = {
  working: "bg-emerald-500",
  attention: "bg-amber-500",
  failed: "bg-destructive",
};

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

const ATTENTION_TASK_STATE: Partial<
  Record<RunStatusInput["state"], NonNullable<RunStatusInput["attentionState"]>>
> = {
  TASK_STATE_INPUT_REQUIRED: "input_required",
  TASK_STATE_AUTH_REQUIRED: "auth_required",
};

const ATTENTION_CHIP_LABEL: Record<
  NonNullable<RunStatusInput["attentionState"]>,
  string
> = {
  input_required: "Needs your input",
  auth_required: "Needs sign-in",
};

const WORKSPACE_SUFFIX: Partial<Record<WorkspaceState, string>> = {
  suspended: "suspended",
  deleted: "workspace removed",
};
