import { CODEX_CLIENT_LABEL } from "@archestra/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Client-app badge for the LLM logs screens, colored per client family so
 * Claude (purple) and Codex (emerald) sessions are distinguishable at a
 * glance. `label` is the value of `clientLabelForExternalAgentIds`
 * (`@archestra/shared`).
 */
export function ClientSourceBadge({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "text-xs",
        label === CODEX_CLIENT_LABEL
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
          : "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
        className,
      )}
    >
      {label}
    </Badge>
  );
}
