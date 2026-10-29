"use client";

import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAssignableTeams, useTeam } from "@/lib/teams/team.query";

/**
 * The team a service account acts for. A linked account receives the team's
 * grants and MCP connections. Org team managers can pick any team; anyone else
 * only the teams they belong to (the API still requires team admin).
 */
export function ServiceAccountTeamSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string | null;
  onChange: (teamId: string | null) => void;
}) {
  const { data: canManageTeams } = useHasPermissions({ team: ["update"] });
  const { data: teams = [] } = useAssignableTeams({
    isResourceAdmin: !!canManageTeams,
  });
  // A linked team outside the caller's own list still needs its name shown.
  const isListed = !value || teams.some((team) => team.id === value);
  const { data: linkedTeam } = useTeam(isListed ? undefined : value);
  const options =
    !isListed && linkedTeam
      ? [{ id: linkedTeam.id, name: linkedTeam.name }, ...teams]
      : teams;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Team</Label>
      <Select
        value={value ?? NO_TEAM}
        onValueChange={(next) => onChange(next === NO_TEAM ? null : next)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="No team" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_TEAM}>No team</SelectItem>
          {options.map((team) => (
            <SelectItem key={team.id} value={team.id}>
              {team.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>
        Optional. The account acts for this team and gets its grants and MCP
        connections.
      </FieldDescription>
    </div>
  );
}

// === Internal helpers

const NO_TEAM = "__none__";
