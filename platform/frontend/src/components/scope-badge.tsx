import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { scopeStyles } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const SCOPE_META: Record<
  ResourceVisibilityScope,
  { label: string; icon: typeof User }
> = {
  personal: { label: "Personal", icon: User },
  team: { label: "Team", icon: Users },
  org: { label: "Organization", icon: Globe },
};

// Icon-only scope pill (personal/team/org) with the label in the tooltip +
// aria-label. Shared across the apps and projects cards so scope reads the same
// everywhere. A team scope folds its team names into the label ("Team: London
// HQ"); pass `hidePersonal` to drop the pill entirely for personal resources.
export function ScopeBadge({
  scope,
  teamNames,
  hidePersonal = false,
}: {
  scope: ResourceVisibilityScope;
  teamNames?: string[] | null;
  hidePersonal?: boolean;
}) {
  if (scope === "personal" && hidePersonal) {
    return null;
  }

  const { label: scopeLabel, icon: Icon } = SCOPE_META[scope];

  const names = teamNames?.filter(Boolean) ?? [];
  const label =
    scope === "team" && names.length > 0
      ? `Team: ${names.join(", ")}`
      : scopeLabel;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          aria-label={label}
          className={cn(scopeStyles[scope], "px-1.5")}
        >
          <Icon className="h-3 w-3" />
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
