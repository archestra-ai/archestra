import type { ResourceVisibilityScope } from "@archestra/shared";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

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
    <Alert variant="warning">
      <AlertTriangle />
      <AlertTitle>You are not a member of the selected teams</AlertTitle>
      <AlertDescription>
        You can still manage settings as an app administrator, but you will not
        be able to modify {subject} through chat.
      </AlertDescription>
    </Alert>
  );
}
