import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils/tailwind";

/** The small chip beside the name of a feature in beta. */
export function BetaBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn("shrink-0 px-1.5 py-0 text-[10px]", className)}
    >
      Beta
    </Badge>
  );
}
