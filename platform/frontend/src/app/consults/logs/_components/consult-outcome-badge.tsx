import { Badge } from "@/components/ui/badge";
import type { ExternalConsultOutcome } from "@/lib/openappa/external-consults.query";

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

export function ConsultOutcomeBadge({
  outcome,
}: {
  outcome: ExternalConsultOutcome;
}) {
  return (
    <Badge
      variant={outcome === "answered" ? "secondary" : "destructive"}
      className="px-1.5 py-0 text-[10px]"
    >
      {OUTCOME_LABEL[outcome]}
    </Badge>
  );
}
