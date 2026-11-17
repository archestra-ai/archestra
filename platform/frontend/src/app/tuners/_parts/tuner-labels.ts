import type { ComponentProps } from "react";
import type { Badge } from "@/components/ui/badge";
import type {
  TunerKind,
  TunerSuggestion,
  TunerSuggestionStatus,
  TunerSummary,
} from "@/lib/tuners.query";

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;
type PolicyChange = Extract<
  TunerSuggestion["action"],
  { type: "policy_change" }
>;
type TunerRun = NonNullable<TunerSummary["lastRun"]>;

export const TUNER_KINDS: TunerKind[] = ["sre", "appa"];

export const TUNER_LABEL: Record<TunerKind, string> = {
  sre: "SRE tuner",
  appa: "APPA tuner",
};

export const SUGGESTION_STATUSES: TunerSuggestionStatus[] = [
  "open",
  "published",
  "effective",
  "done",
  "rejected",
  "resolved",
];

export const STATUS_LABEL: Record<TunerSuggestionStatus, string> = {
  open: "Open",
  published: "Published",
  effective: "Effective",
  done: "Done",
  rejected: "Rejected",
  resolved: "Resolved",
};

export const SEVERITY: Record<
  TunerSuggestion["severity"],
  { label: string; variant: BadgeVariant }
> = {
  critical: { label: "Critical", variant: "destructive" },
  warn: { label: "Warning", variant: "secondary" },
  info: { label: "Info", variant: "outline" },
};

export const SOURCE_LABEL: Record<TunerSuggestion["source"], string> = {
  sre_oom_killed: "Out-of-memory kills",
  sre_restart_loop: "Restart loop",
  sre_pod_stuck: "Stuck pod",
  sre_replicas_unavailable: "Unavailable replicas",
  appa_hitl_approvals: "Repeated approvals",
  appa_hitl_denials: "Repeated denials by reviewers",
  appa_repeated_denials: "Repeated policy denials",
  appa_unresolved_yell: "Unresolved yell",
  appa_observe_auto_approvals: "Observe-mode auto-approvals",
};

export const RUN_STATUS_LABEL: Record<TunerRun["status"], string> = {
  running: "Running",
  success: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function runOutcomeLabel(scan: NonNullable<TunerRun["scan"]>): string {
  switch (scan.outcome) {
    case "no_candidates":
      return "Nothing to review";
    case "all_suppressed":
      return "Only known findings";
    case "agent_ran":
      return `Reviewed ${scan.candidateCount} candidate${scan.candidateCount === 1 ? "" : "s"}`;
  }
}

export const VERIFICATION_REASON_LABEL: Record<
  PolicyChange["gate"]["reasons"][number],
  string
> = {
  no_saved_validations: "No saved validations cover this policy",
  replay_unavailable: "Replay of past calls is unavailable",
  validation_cannot_run: "Some validations could not run",
};
