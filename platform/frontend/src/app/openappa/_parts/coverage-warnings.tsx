import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { CoverageSummary } from "@/lib/openappa-coverage.query";

export function CoverageWarnings({
  totals,
}: {
  totals: CoverageSummary["totals"];
}) {
  const warnings = [
    {
      count: totals.notCovered,
      title: "Always allowed",
      description:
        "These tools can run without policy restrictions. Add rules to control what your agents can do.",
      variant: "error" as const,
    },
    {
      count: totals.catchAll,
      title: "Covered by a catch-all rule",
      description:
        "One rule covers all these tools. Add specific rules to set limits for individual tools.",
      variant: "warning" as const,
    },
  ];

  return warnings
    .filter((warning) => warning.count > 0)
    .map((warning) => (
      <Alert key={warning.title} variant={warning.variant}>
        <AlertTriangle />
        <AlertTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>{warning.title}</span>
          <Badge variant="outline" className="tabular-nums">
            {`${warning.count.toLocaleString()} ${warning.count === 1 ? "tool" : "tools"}`}
          </Badge>
        </AlertTitle>
        <AlertDescription>{warning.description}</AlertDescription>
      </Alert>
    ));
}
