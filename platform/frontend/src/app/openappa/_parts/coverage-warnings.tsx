import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
      description: `${Math.round((totals.notCovered / totals.tools) * 100)}% of your tools can run without policy restrictions. Add rules to control what your agents can do.`,
      variant: "error" as const,
    },
    {
      count: totals.catchAll,
      title: "Covered by a catch-all rule",
      description: `${Math.round((totals.catchAll / totals.tools) * 100)}% of your tools share one catch-all rule. Add specific rules to set limits for individual tools.`,
      variant: "warning" as const,
    },
  ];

  return warnings
    .filter((warning) => totals.tools > 0 && warning.count > 0)
    .map((warning) => (
      <Alert key={warning.title} variant={warning.variant}>
        <AlertTriangle />
        <AlertTitle>{warning.title}</AlertTitle>
        <AlertDescription>{warning.description}</AlertDescription>
      </Alert>
    ));
}
