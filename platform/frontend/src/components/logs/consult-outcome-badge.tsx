import type { ExternalConsultOutcome } from "@/lib/openappa/external-consults.query";
import { cn } from "@/lib/utils/tailwind";

export const OUTCOME_LABEL: Record<ExternalConsultOutcome, string> = {
  answered: "Answered",
  unregistered: "Unregistered",
  unreachable: "Unreachable",
  dismissed: "Dismissed",
  non_success: "Non-success",
  timeout: "Timeout",
  transport: "Transport error",
  malformed: "Malformed",
  oversized: "Oversized",
  unsupported_version: "Unsupported version",
  module_error: "Module error",
  module_panicked: "Module panicked",
};

export const ALL_OUTCOMES = Object.keys(
  OUTCOME_LABEL,
) as ExternalConsultOutcome[];

/** A consult's outcome as a small chip, sized like the trace's check chips. */
export function ConsultOutcomeBadge({
  outcome,
}: {
  outcome: ExternalConsultOutcome;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-sm px-1 text-[10px] leading-none font-medium",
        outcome === "answered"
          ? "bg-muted text-muted-foreground"
          : "bg-destructive/15 text-destructive",
      )}
    >
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}
