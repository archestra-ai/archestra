import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const styles = {
  personal:
    "bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-400 dark:border-blue-400/30",
  team: "bg-green-500/10 text-green-600 border-green-500/30 dark:text-green-400 dark:border-green-400/30",
  org: "bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400 dark:border-amber-400/30",
  builtIn:
    "bg-purple-500/10 text-purple-600 border-purple-500/30 dark:text-purple-400 dark:border-purple-400/30",
} as const;
const labels = {
  personal: "Personal",
  team: "Team",
  org: "Organization",
  builtIn: "Built-in",
} as const;
const commonClasses = "text-[11px] shrink-0";

function AgentBadge({
  type,
  className,
}: {
  type: "personal" | "team" | "org" | "builtIn";
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
