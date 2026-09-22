"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { useState } from "react";
import { SearchableMultiSelect } from "@/components/searchable-multi-select";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserSearchableMultiSelect } from "@/components/user-searchable-multi-select";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { formatTeamPath } from "@/lib/teams/team-hierarchy";

type A2aVisibilityChoice = ResourceVisibilityScope | "user";

/** Remote A2A discovery still uses its own sharing API, separate from local-agent grants. */
export function A2aRemoteAgentScopeSelector({
  scope,
  onScopeChange,
  teamIds,
  onTeamIdsChange,
  userIds,
  onUserIdsChange,
  onChoiceChange,
  initialScope,
}: {
  scope: ResourceVisibilityScope;
  onScopeChange: (scope: ResourceVisibilityScope) => void;
  teamIds: string[];
  onTeamIdsChange: (ids: string[]) => void;
  userIds: string[];
  onUserIdsChange: (ids: string[]) => void;
  onChoiceChange?: (choice: A2aVisibilityChoice) => void;
  initialScope?: ResourceVisibilityScope;
}) {
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: canManageExternalAgents } = useHasPermissions({
    agentSettings: ["update"],
  });
  const { data: isAdmin } = useHasPermissions({ agent: ["admin"] });
  const { data: isTeamAdmin } = useHasPermissions({ agent: ["team-admin"] });
  const canShareOrganization = !!canManageExternalAgents || !!isAdmin;
  const canShareTeams = canShareOrganization || !!isTeamAdmin;
  const { data: teams = [] } = useTeams({ enabled: !!canReadTeams });
  const { data: members = [] } = useOrganizationMembers();
  const { data: session } = useSession();
  const [choosingPeople, setChoosingPeople] = useState(userIds.length > 0);
  const choice =
    scope === "personal" && (choosingPeople || userIds.length > 0)
      ? "user"
      : scope;
  const personalLocked = !!initialScope && initialScope !== "personal";
  const selectChoice = (value: A2aVisibilityChoice) => {
    setChoosingPeople(value === "user");
    if (value !== "user") onUserIdsChange([]);
    onScopeChange(value === "user" ? "personal" : value);
    onChoiceChange?.(value);
  };
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="a2a-sharing">Who can discover this remote agent</Label>
        <Select value={choice} onValueChange={selectChoice}>
          <SelectTrigger id="a2a-sharing">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="personal" disabled={personalLocked}>
              <User className="size-4" />
              <span>Only you</span>
            </SelectItem>
            <SelectItem value="user" disabled={personalLocked}>
              <User className="size-4" />
              <span>Selected people</span>
            </SelectItem>
            <SelectItem
              value="team"
              disabled={!canShareTeams || !canReadTeams || teams.length === 0}
            >
              <Users className="size-4" />
              <span>Selected teams</span>
            </SelectItem>
            <SelectItem value="org" disabled={!canShareOrganization}>
              <Globe className="size-4" />
              <span>Everyone in the organization</span>
            </SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>
          Controls discovery in this organization. The remote agent manages its
          own authentication.
        </FieldDescription>
      </div>
      {choice === "user" && (
        <UserSearchableMultiSelect
          value={userIds}
          onValueChange={onUserIdsChange}
          users={members
            .filter((member) => member.id !== session?.user.id)
            .map((member) => ({
              userId: member.id,
              name: member.name,
              email: member.email,
            }))}
          placeholder="Select people"
          searchPlaceholder="Search people..."
        />
      )}
      {choice === "team" && (
        <SearchableMultiSelect
          ariaLabel="Teams"
          value={teamIds}
          onValueChange={onTeamIdsChange}
          disabled={!canReadTeams || !canShareTeams}
          items={teams.map((team) => ({
            value: team.id,
            label: team.name,
            description: formatTeamPath(teams, team.id),
          }))}
          placeholder="Select teams"
          searchPlaceholder="Search teams..."
        />
      )}
    </div>
  );
}
