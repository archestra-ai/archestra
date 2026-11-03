import { Badge } from "@/components/ui/badge";

export function BetaBadge() {
  return (
    <Badge
      variant="outline"
      className="border-transparent bg-sidebar-chip px-1.5 py-0 text-[10px] text-sidebar-emphasis dark:border-sidebar-emphasis dark:bg-sidebar"
    >
      Beta
    </Badge>
  );
}
