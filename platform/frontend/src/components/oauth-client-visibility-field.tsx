"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import {
  formatPermissionRequirement,
  PermissionRequirementHint,
} from "@/components/permission-requirement-hint";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAssignableTeams } from "@/lib/teams/team.query";

/**
 * Scope + teams picker for OAuth client create/edit dialogs (both the LLM
 * proxy and MCP gateway variants). Mirrors the agent dialog's access-level
 * selector: `org` scope needs `<resource>:admin`, `team` scope needs
 * `<resource>:team-admin`, and a shared client can never go back to personal.
 * Scope only controls who can see and manage the credential — it does not
 * change what its tokens can reach at runtime.
 */
export function OauthClientVisibilityField({
  resource,
  scope,
  onScopeChange,
  teamIds,
  onTeamIdsChange,
  initialScope,
}: {
  resource: "llmOauthClient" | "mcpOauthClient";
  scope: ResourceVisibilityScope;
  onScopeChange: (scope: ResourceVisibilityScope) => void;
  teamIds: string[];
  onTeamIdsChange: (ids: string[]) => void;
  /** Scope the client currently has (edit only); guards shared → personal. */
  initialScope?: ResourceVisibilityScope;
}) {
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: isAdmin } = useHasPermissions({ [resource]: ["admin"] });
  const { data: isTeamAdmin } = useHasPermissions({
    [resource]: ["team-admin"],
  });
  // Picker offers all teams to a full resource-admin, otherwise only the teams
  // the user belongs to (the only ones the backend lets a team-admin assign).
  const { data: teams } = useAssignableTeams({
    isResourceAdmin: !!isAdmin,
    enabled: !!canReadTeams,
  });

  const canShareWithTeams = !!isAdmin || !!isTeamAdmin;
  const hasNoAvailableTeams = !teams || teams.length === 0;

  const isOptionDisabled = (value: ResourceVisibilityScope) => {
    if (value === "personal" && initialScope && initialScope !== "personal")
      return true;
    if (value === "team" && (!canShareWithTeams || !canReadTeams)) return true;
    if (value === "org" && !isAdmin) return true;
    return false;
  };

  const getDisabledReason = (value: ResourceVisibilityScope) => {
    if (value === "personal" && initialScope && initialScope !== "personal")
      return "Shared OAuth clients cannot be made personal";
    if (value === "team" && !canReadTeams)
      return `Team sharing is unavailable without ${formatPermissionRequirement({ resource: "team", action: "read" })}`;
    if (value === "team" && !canShareWithTeams)
      return `You need ${resource}:team-admin permission to share with teams`;
    if (value === "org" && !isAdmin)
      return `You need ${resource}:admin permission to make this available org-wide`;
    return "";
  };

  const baseOptions: VisibilityOption<ResourceVisibilityScope>[] = [
    {
      value: "personal",
      label: "Personal",
      description: "Only you can see and manage this OAuth client",
      icon: User,
    },
    {
      value: "team",
      label: "Teams",
      description: "Share this OAuth client with selected teams",
      icon: Users,
    },
    {
      value: "org",
      label: "Organization",
      description: "Anyone in your org can see this OAuth client",
      icon: Globe,
    },
  ];
  const options = baseOptions.map((option) => ({
    ...option,
    disabled: isOptionDisabled(option.value),
    disabledReason: isOptionDisabled(option.value)
      ? getDisabledReason(option.value)
      : undefined,
  }));

  return (
    <VisibilitySelector
      heading="Who can see and manage this OAuth client"
      value={scope}
      options={options}
      onValueChange={onScopeChange}
    >
      {scope === "team" && (
        <div className="space-y-2">
          <Label>Teams *</Label>
          <MultiSelectCombobox
            disabled={
              !canShareWithTeams || hasNoAvailableTeams || !canReadTeams
            }
            options={
              teams?.map((team) => ({
                value: team.id,
                label: team.name,
              })) || []
            }
            value={teamIds}
            onChange={onTeamIdsChange}
            placeholder={
              !canReadTeams
                ? "Teams unavailable"
                : hasNoAvailableTeams
                  ? "No teams available"
                  : "Search teams..."
            }
            emptyMessage="No teams found."
          />
          {!canReadTeams && (
            <PermissionRequirementHint
              message="Team selection is unavailable without"
              permissions={[{ resource: "team", action: "read" }]}
            />
          )}
        </div>
      )}
    </VisibilitySelector>
  );
}
