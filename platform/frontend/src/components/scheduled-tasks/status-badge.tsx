import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function StatusBadge({ label }: { label: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-border/60 px-2 py-0.5 text-xs capitalize",
        label === "success" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
        label === "failed" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
        label === "running" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      {label}
    </Badge>
  );
}
