import { Badge } from "@/components/ui/badge";

/** How the validations stand, as a badge. */
export function ValidationStatusBadge({
  status,
}: {
  status: "passed" | "failed" | "cannot_run" | "not_run";
}) {
  const color =
    status === "passed"
      ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
      : status === "failed"
        ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400"
        : status === "cannot_run"
          ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-800 dark:text-yellow-300"
          : undefined;
  return (
    <Badge variant="outline" className={color}>
      {LABEL[status]}
    </Badge>
  );
}

const LABEL = {
  passed: "Passed",
  failed: "Failed",
  cannot_run: "Cannot run",
  not_run: "Not run",
} as const;
