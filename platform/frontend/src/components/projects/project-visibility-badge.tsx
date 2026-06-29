import { Globe, User, Users } from "lucide-react";
import { scopeStyles } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  describeProjectVisibility,
  type ProjectVisibility,
} from "./project-visibility";

const scopeIcons = {
  personal: User,
  team: Users,
  org: Globe,
} as const;

// Icon-only scope pill for a project's share visibility. Reuses scopeStyles and
// the User/Users/Globe icons from ResourceVisibilityBadge so personal/team/org
// reads identically here and across apps/MCP/proxies/skills. The pill is
// icon-only to sit alongside the role badge and actions menu without crowding
// narrow cards; its label rides in the tooltip and aria-label.
export function ProjectVisibilityBadge({
  visibility,
  teamNames,
}: {
  visibility: ProjectVisibility;
  teamNames?: string[] | null;
}) {
  const { scope, label } = describeProjectVisibility(visibility, teamNames);
  const Icon = scopeIcons[scope];

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
