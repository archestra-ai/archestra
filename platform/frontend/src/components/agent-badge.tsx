import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const styles = {
  personal: "bg-blue-500/10 text-blue-600 border-blue-500/30",
  shared: "bg-green-500/10 text-green-600 border-green-500/30",
  builtIn: "bg-purple-500/10 text-purple-600 border-purple-500/30",
} as const;
const commonClasses = "text-[11px] shrink-0";

function AgentBadge({
  type,
  className,
}: {
  type: "personal" | "team" | "org" | "builtIn";
  className?: string;
}) {
  if (type === "builtIn") {
    return (
      <Badge
        variant="outline"
        className={cn(styles.builtIn, commonClasses, className)}
      >
        Built-In
      </Badge>
    );
  }
  if (type === "personal") {
    return (
      <Badge
        variant="outline"
        className={cn(styles.personal, commonClasses, className)}
      >
        Personal
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn(styles.shared, commonClasses, className)}
    >
      Shared
    </Badge>
  );
}

export { AgentBadge };
