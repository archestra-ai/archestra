import type { ResourceVisibilityScope } from "@archestra/shared";
import { UserRoundCheck } from "lucide-react";
import {
  SCOPE_META,
  scopeLabel,
  scopeStyles,
} from "@/components/scope-vocabulary";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Icon-only scope pill (personal/team/org) with the label in the tooltip +
// aria-label. Shared across the apps and projects cards so scope reads the same
// everywhere. A team scope folds its team names into the label ("Team: London
// HQ"); pass `hidePersonal` to drop the pill entirely for personal resources.
export function ScopeBadge({
  scope,
  teamNames,
  userNames,
  hidePersonal = false,
}: {
  scope: ResourceVisibilityScope;
  teamNames?: string[] | null;
  /**
   * People the resource is shared with individually. An app shared this way is
   * stored as `personal` plus grants, so reading the scope literally would
   * label a shared app "Personal" — the very confusion this pill should settle.
   * Resources without per-user grants simply omit it and are unaffected.
   */
  userNames?: string[] | null;
  hidePersonal?: boolean;
}) {
  const sharedWith = userNames?.filter(Boolean) ?? [];
  const sharedWithUsers = scope === "personal" && sharedWith.length > 0;

  if (scope === "personal" && hidePersonal && !sharedWithUsers) {
    return null;
  }

  const { icon: scopeIcon } = SCOPE_META[scope];
  const Icon = sharedWithUsers ? UserRoundCheck : scopeIcon;

  const names = teamNames?.filter(Boolean) ?? [];
  const label = sharedWithUsers
    ? `Shared with: ${sharedWith.join(", ")}`
    : scope === "team" && names.length > 0
      ? `Team: ${names.join(", ")}`
      : scopeLabel(scope);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          aria-label={label}
          className={cn(
            scopeStyles[sharedWithUsers ? "team" : scope],
            "px-1.5",
          )}
        >
          <Icon className="h-3 w-3" />
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
