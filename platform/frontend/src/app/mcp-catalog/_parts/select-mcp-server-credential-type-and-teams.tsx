"use client";

import { E2eTestId } from "@shared";
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
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useFeatureFlag } from "@/lib/features.hook";
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
  /** Callback when credential type changes (personal vs team) */
  onCredentialTypeChange?: (type: "personal" | "team") => void;
}

export function SelectMcpServerCredentialTypeAndTeams({
  selectedTeamId,
  onTeamChange,
  catalogId,
  onCredentialTypeChange,
}: SelectMcpServerCredentialTypeAndTeamsProps) {
  const { data: teams, isLoading: isLoadingTeams } = useTeams();
  const byosEnabled = useFeatureFlag("byosEnabled");
  const { data: installedServers } = useMcpServers();
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;

  // WHY: Check mcpServer:update permission to determine if user can create team installations
  // Editors have this permission, members don't. This prevents members from installing
  // MCP servers that affect the whole team - only editors and admins can do that.
  const { data: hasMcpServerUpdate } = useHasPermissions({
    mcpServer: ["update"],
  });

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
    // Force team selection when BYOS is enabled
    if (byosEnabled && availableTeams.length > 0) {
      return CredentialType.Team;
    }
    if (hasPersonalInstallation && availableTeams.length > 0) {
      return CredentialType.Team;
    }
    return CredentialType.Personal;
  }, [byosEnabled, hasPersonalInstallation, availableTeams.length]);

  const [credentialType, setCredentialType] = useState<
    (typeof CredentialType)[keyof typeof CredentialType]
  >(initialCredentialType);

  // Update credential type when initial value changes (e.g., after data loads)
  // Also notifies parent of the current credential type
  useEffect(() => {
    // Force team selection when BYOS is enabled or personal is already installed
    if (
      (hasPersonalInstallation || byosEnabled) &&
      credentialType === CredentialType.Personal
    ) {
      if (availableTeams.length > 0) {
        setCredentialType(CredentialType.Team);
        onCredentialTypeChange?.(CredentialType.Team);
        return;
      }
    }
    // Always notify parent of current credential type when dependencies change
    onCredentialTypeChange?.(credentialType);
  }, [
    hasPersonalInstallation,
    byosEnabled,
    availableTeams.length,
    credentialType,
    onCredentialTypeChange,
  ]);

  const handleCredentialTypeChange = (
    value: (typeof CredentialType)[keyof typeof CredentialType],
  ) => {
    setCredentialType(value);
    onCredentialTypeChange?.(value);
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

  const isPersonalDisabled = hasPersonalInstallation || byosEnabled;
  // WHY: Team option is disabled if:
  // 1. No teams available (user is not a member of any team with available slots)
  // 2. User lacks mcpServer:update permission (members don't have it, only editors/admins do)
  // This enforces that only editors and admins can create team-wide MCP server installations.
  const isTeamDisabled = availableTeams.length === 0 || !hasMcpServerUpdate;

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
              data-testid={E2eTestId.SelectCredentialTypePersonal}
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
                  {byosEnabled
                    ? "(not available when Readonly Vault is enabled)"
                    : "(already created for this MCP server)"}
                </span>
              )}
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <RadioGroupItem
              value={CredentialType.Team}
              id="r2"
              disabled={isTeamDisabled}
              data-testid={E2eTestId.SelectCredentialTypeTeam}
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
                  {/* WHY: Show different messages based on why team option is disabled:
                      1. No permission - members can't create team installations
                      2. No teams - user isn't a member of any team
                      3. All teams used - all user's teams already have this server */}
                  {!hasMcpServerUpdate
                    ? "(you don't have permission to create team installations)"
                    : teams?.length === 0
                      ? "(you are not a member of any team)"
                      : "(all your teams already have this server installed)"}
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
            <SelectContent
              data-testid={E2eTestId.SelectCredentialTypeTeamDropdown}
            >
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
