"use client";

import { useEffect, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useMcpServers } from "@/lib/mcp-server.query";
import { useTeams } from "@/lib/team.query";
import { cn } from "@/lib/utils";

const CredentialType = {
  Personal: "personal",
  Team: "team",
} as const;

interface SelectMcpServerCredentialTypeAndTeamsProps {
  selectedTeamId: string | null;
  onTeamChange: (teamId: string | null) => void;
  /** Catalog ID to filter existing installations - if provided, disables already-used options */
  catalogId?: string;
}

export function SelectMcpServerCredentialTypeAndTeams({
  selectedTeamId,
  onTeamChange,
  catalogId,
}: SelectMcpServerCredentialTypeAndTeamsProps) {
  const { data: teams, isLoading: isLoadingTeams } = useTeams();
  const { data: installedServers } = useMcpServers();
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;

  // Compute existing installations for this catalog item
  const { hasPersonalInstallation, teamsWithInstallation } = useMemo(() => {
    if (!catalogId || !installedServers) {
      return { hasPersonalInstallation: false, teamsWithInstallation: [] };
    }

    const serversForCatalog = installedServers.filter(
      (s) => s.catalogId === catalogId,
    );

    const hasPersonal = serversForCatalog.some(
      (s) => s.ownerId === currentUserId && !s.teamId,
    );

    const teamsWithInstall = serversForCatalog
      .filter((s): s is typeof s & { teamId: string } => !!s.teamId)
      .map((s) => s.teamId);

    return {
      hasPersonalInstallation: hasPersonal,
      teamsWithInstallation: teamsWithInstall,
    };
  }, [catalogId, installedServers, currentUserId]);

  // Filter available teams to exclude those that already have this server installed
  const availableTeams = useMemo(() => {
    if (!teams) return [];
    if (!catalogId) return teams; // No filtering if no catalogId provided
    return teams.filter((t) => !teamsWithInstallation.includes(t.id));
  }, [teams, catalogId, teamsWithInstallation]);

  // Determine initial credential type based on what's available
  const initialCredentialType = useMemo(() => {
    if (hasPersonalInstallation && availableTeams.length > 0) {
      return CredentialType.Team;
    }
    return CredentialType.Personal;
  }, [hasPersonalInstallation, availableTeams.length]);

  const [credentialType, setCredentialType] = useState<
    (typeof CredentialType)[keyof typeof CredentialType]
  >(initialCredentialType);

  // Update credential type when initial value changes (e.g., after data loads)
  useEffect(() => {
    if (hasPersonalInstallation && credentialType === CredentialType.Personal) {
      if (availableTeams.length > 0) {
        setCredentialType(CredentialType.Team);
      }
    }
  }, [hasPersonalInstallation, availableTeams.length, credentialType]);

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

  // Auto-select first available team when switching to team mode
  useEffect(() => {
    if (credentialType === CredentialType.Team && availableTeams?.[0]) {
      onTeamChange(availableTeams[0].id);
    }
  }, [credentialType, availableTeams, onTeamChange]);

  const isPersonalDisabled = hasPersonalInstallation;
  const isTeamDisabled = availableTeams.length === 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Credential Type</Label>
        <RadioGroup
          value={credentialType}
          onValueChange={handleCredentialTypeChange}
        >
          <div className="flex items-center gap-3">
            <RadioGroupItem
              value={CredentialType.Personal}
              id="r1"
              disabled={isPersonalDisabled}
            />
            <Label
              htmlFor="r1"
              className={cn(
                "flex items-baseline gap-2",
                isPersonalDisabled && "opacity-50",
              )}
            >
              Personal
              {isPersonalDisabled && (
                <span className="text-xs text-muted-foreground">
                  (already created for this MCP server)
                </span>
              )}
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <RadioGroupItem
              value={CredentialType.Team}
              id="r2"
              disabled={isTeamDisabled}
            />
            <Label
              htmlFor="r2"
              className={cn(
                "flex items-baseline gap-2",
                isTeamDisabled && "opacity-50",
              )}
            >
              Team{" "}
              {isTeamDisabled && (
                <span className="text-xs text-muted-foreground">
                  {teams?.length === 0
                    ? "You can share credential with a team only if you are a member of it. There are no teams available."
                    : "All your teams already have this server installed."}
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
              {availableTeams?.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {availableTeams?.length === 0 && !isLoadingTeams && (
            <p className="text-xs text-muted-foreground">
              No teams available. Create a team first to share this server.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
