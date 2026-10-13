import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { CoverageSummary } from "@/lib/openappa-coverage.query";

/**
 * Tools no rule restricts, as a warning; tools that only a catch-all rule
 * covers are covered, so they get a quiet hint instead.
 */
export function CoverageWarnings({
  totals,
}: {
  totals: CoverageSummary["totals"];
}) {
  if (totals.tools === 0) return null;
  return (
    <>
      {totals.notCovered > 0 && (
        <Alert variant="error">
          <AlertTriangle />
          <AlertTitle>Always allowed</AlertTitle>
          <AlertDescription>
            {`${Math.round((totals.notCovered / totals.tools) * 100)}% of your tools can run without policy restrictions. Add rules to control what your agents can do.`}
          </AlertDescription>
        </Alert>
      )}
      {totals.catchAll > 0 && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          {`${totals.catchAll.toLocaleString()} ${totals.catchAll === 1 ? "tool relies" : "tools rely"} on one catch-all rule. Add specific rules where a tool needs its own limits.`}
        </p>
      )}
    </>
  );
}
