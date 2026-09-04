import type { ResourceVisibilityScope } from "@archestra/shared";
import { AlertTriangle } from "lucide-react";
import {
  CompactWarning,
  CompactWarningText,
} from "@/components/ui/compact-warning";

/**
 * One warning for every Apps visibility editor. App administrators may assign
 * any team, but chat authoring follows team membership; selecting only teams
 * they do not belong to therefore preserves settings access while removing
 * their ability to continue modifying the app through chat.
 */
export function AppTeamAccessWarning({
  scope,
  selectedTeamIds,
  isAppAdmin,
  userTeamIds,
  subject = "this app",
}: {
  scope: ResourceVisibilityScope | "user";
  selectedTeamIds: readonly string[];
  isAppAdmin: boolean;
  userTeamIds: ReadonlySet<string>;
  subject?: string;
}) {
  const outsideSelectedTeams =
    scope === "team" &&
    selectedTeamIds.length > 0 &&
    isAppAdmin &&
    !selectedTeamIds.some((teamId) => userTeamIds.has(teamId));

  if (!outsideSelectedTeams) return null;

  return (
    <CompactWarning>
      <AlertTriangle />
      <span className="font-medium">
        You are not a member of the selected teams.
      </span>
      <CompactWarningText>
        You can still manage settings as an app administrator, but you will not
        be able to modify {subject} through chat.
      </CompactWarningText>
    </CompactWarning>
  );
}
