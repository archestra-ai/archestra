import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils/tailwind";

/**
 * The chip of a feature in alpha, beside its name: the same small badge the
 * app uses for Beta.
 */
export function AlphaBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn("shrink-0 px-1.5 py-0 text-[10px]", className)}
    >
      Alpha
    </Badge>
  );
}
