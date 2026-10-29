import { platformOwnedStyles } from "@/components/scope-vocabulary";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils/tailwind";

export function BuiltInAgentBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        platformOwnedStyles,
        "text-[11px] leading-none shrink-0 py-0.5 pt-[3px] pb-[2px]",
        className,
      )}
    >
      Built-in
    </Badge>
  );
}
