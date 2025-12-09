"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTeams } from "@/lib/team.query";
import { cn } from "@/lib/utils";

const CredentialType = {
  Personal: "personal",
  Team: "team",
} as const;

interface SelectMcpServerCredentialTypeAndTeamsProps {
  selectedTeamId: string | null;
  onTeamChange: (teamId: string | null) => void;
}
export function SelectMcpServerCredentialTypeAndTeams({
  selectedTeamId,
  onTeamChange,
}: SelectMcpServerCredentialTypeAndTeamsProps) {
  const { data: teams, isLoading: isLoadingTeams } = useTeams();
  const [credentialType, setCredentialType] = useState<
    (typeof CredentialType)[keyof typeof CredentialType]
  >(CredentialType.Personal);

  const handleCredentialTypeChange = (
    value: (typeof CredentialType)[keyof typeof CredentialType],
  ) => {
    setCredentialType(value);
    // Reset team selection when switching to personal
    if (value === CredentialType.Personal) {
      onTeamChange(null);
    }
  };

  const handleTeamChange = (value: string) => {
    onTeamChange(value || null);
  };

  useEffect(() => {
    if (credentialType === CredentialType.Team && teams?.[0]) {
      onTeamChange(teams[0].id);
    }
  }, [credentialType, teams, onTeamChange]);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Credential Type</Label>
        <RadioGroup
          defaultValue={CredentialType.Personal}
          onValueChange={handleCredentialTypeChange}
        >
          <div className="flex items-center gap-3">
            <RadioGroupItem value={CredentialType.Personal} id="r1" />
            <Label htmlFor="r1">Personal</Label>
          </div>
          <div className="flex items-center gap-3">
            <RadioGroupItem
              value={CredentialType.Team}
              id="r2"
              disabled={!teams?.length}
            />
            <Label
              htmlFor="r2"
              className={cn(
                "flex items-baseline gap-2",
                !teams?.length && "opacity-50",
              )}
            >
              Team{" "}
              {!teams?.length && (
                <span className="text-xs text-muted-foreground">
                  You can share credential with a team only if you are a member
                  of it. No teams available.
                </span>
              )}
            </Label>
          </div>
        </RadioGroup>
      </div>

      {credentialType === "team" && (
        <div className="space-y-2">
          <Label>
            Team <span className="text-destructive">*</span>
          </Label>
          <Select
            value={selectedTeamId || ""}
            onValueChange={handleTeamChange}
            disabled={isLoadingTeams}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  isLoadingTeams ? "Loading teams..." : "Select a team"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {teams?.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {teams?.length === 0 && !isLoadingTeams && (
            <p className="text-xs text-muted-foreground">
              No teams available. Create a team first to share this server.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
