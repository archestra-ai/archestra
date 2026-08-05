import type { AgentScope } from "@archestra/shared";
import { SCOPE_META } from "@/components/scope-vocabulary";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// The three visibility scopes speak the shared vocabulary. "builtIn" is not a
// scope — it marks an agent Archestra ships rather than one an org created — so
// its colour and label stay local to this badge.
const styles = {
  personal: SCOPE_META.personal.styles,
  team: SCOPE_META.team.styles,
  org: SCOPE_META.org.styles,
  builtIn:
    "bg-purple-500/10 text-purple-700 border-purple-500/30 dark:text-purple-400 dark:border-purple-400/30",
} as const;
const labels = {
  personal: SCOPE_META.personal.label,
  team: SCOPE_META.team.label,
  org: SCOPE_META.org.label,
  builtIn: "Built-in",
} as const;
const commonClasses =
  "text-[11px] leading-none shrink-0 py-0.5 pt-[3px] pb-[2px]";

function AgentBadge({
  type,
  className,
}: {
  type: AgentScope | "builtIn";
  className?: string;
}) {
  const style = styles[type];
  const label = labels[type];

  return (
    <Badge variant="outline" className={cn(style, commonClasses, className)}>
      {label}
    </Badge>
  );
}

export { AgentBadge };
