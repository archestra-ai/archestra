"use client";

import { E2eTestId } from "@shared";
import { useEffect, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useFeatureFlag } from "@/lib/features.hook";
import { useMcpServers } from "@/lib/mcp-server.query";
import { useTeams } from "@/lib/team.query";

const PERSONAL_VALUE = "personal";

interface SelectMcpServerCredentialTypeAndTeamsProps {
  onTeamChange: (teamId: string | null) => void;
  /** Catalog ID to filter existing installations - if provided, disables already-used options */
  catalogId?: string;
  /** Callback when credential type changes (personal vs team) */
  onCredentialTypeChange?: (type: "personal" | "team") => void;
  /** When true, this is a reinstall - credential type is locked to existing value */
  isReinstall?: boolean;
  /** The team ID of the existing server being reinstalled (null/undefined = personal) */
  existingTeamId?: string | null;
  /** When true, only personal installation is allowed (teams are disabled) */
  personalOnly?: boolean;
}

export function SelectMcpServerCredentialTypeAndTeams({
  onTeamChange,
  catalogId,
  onCredentialTypeChange,
  isReinstall = false,
  existingTeamId,
  personalOnly = false,
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
  // For reinstall: include ALL teams (no filtering needed since we're updating, not creating)
  const availableTeams = useMemo(() => {
    if (!teams) return [];
    if (isReinstall) return teams; // No filtering for reinstall
    if (!catalogId) return teams; // No filtering if no catalogId provided
    return teams.filter((t) => !teamsWithInstallation.includes(t.id));
  }, [teams, catalogId, teamsWithInstallation, isReinstall]);

  // WHY: During reinstall, lock credential type to existing value (can't change ownership)
  // Personal is disabled if: reinstalling a team server, or (for new install) already has personal or BYOS enabled
  const isPersonalDisabled = personalOnly
    ? false
    : isReinstall
      ? !!existingTeamId // Reinstalling team server - can't switch to personal
      : hasPersonalInstallation || byosEnabled;

  // WHY: Team options are disabled if:
  // 1. personalOnly mode (e.g. Playwright - only personal installs allowed)
  // 2. Reinstalling a personal server (can't switch to team)
  // 3. User lacks mcpServer:update permission AND personal is still available.
  //    When personal is unavailable (already installed or BYOS), teams must stay
  //    enabled since they are the only option
  const areTeamsDisabled = personalOnly
    ? true
    : isReinstall
      ? !existingTeamId // Reinstalling personal server - can't switch to team
      : !hasMcpServerUpdate && !isPersonalDisabled;

  // Compute the initial dropdown value
  const initialValue = useMemo(() => {
    if (personalOnly) {
      return PERSONAL_VALUE;
    }
    if (isReinstall) {
      return existingTeamId || PERSONAL_VALUE;
    }
    // Force team selection when BYOS is enabled or personal is already installed
    if ((byosEnabled || hasPersonalInstallation) && availableTeams.length > 0) {
      return availableTeams[0].id;
    }
    return PERSONAL_VALUE;
  }, [
    personalOnly,
    byosEnabled,
    hasPersonalInstallation,
    availableTeams,
    isReinstall,
    existingTeamId,
  ]);

  const [selectedValue, setSelectedValue] = useState<string>(initialValue);

  // Sync when constraints change (e.g., data loads asynchronously)
  // Also notifies parent of the current credential type and team
  useEffect(() => {
    // For reinstall, don't auto-switch - keep the existing value
    if (isReinstall) {
      const isTeam = selectedValue !== PERSONAL_VALUE;
      onCredentialTypeChange?.(isTeam ? "team" : "personal");
      onTeamChange(isTeam ? selectedValue : null);
      return;
    }

    // Force away from personal when BYOS is enabled or personal already installed
    if (
      (hasPersonalInstallation || byosEnabled) &&
      selectedValue === PERSONAL_VALUE
    ) {
      if (availableTeams.length > 0) {
        setSelectedValue(availableTeams[0].id);
        onCredentialTypeChange?.("team");
        onTeamChange(availableTeams[0].id);
        return;
      }
    }

    // Always notify parent of current state when dependencies change
    const isTeam = selectedValue !== PERSONAL_VALUE;
    onCredentialTypeChange?.(isTeam ? "team" : "personal");
    onTeamChange(isTeam ? selectedValue : null);
  }, [
    hasPersonalInstallation,
    byosEnabled,
    availableTeams,
    selectedValue,
    onCredentialTypeChange,
    onTeamChange,
    isReinstall,
  ]);

  const handleValueChange = (value: string) => {
    setSelectedValue(value);
    if (value === PERSONAL_VALUE) {
      onCredentialTypeChange?.("personal");
      onTeamChange(null);
    } else {
      onCredentialTypeChange?.("team");
      onTeamChange(value);
    }
  };

  return (
    <div className="space-y-2">
      <Label>Installation Type</Label>
      <Select
        value={selectedValue}
        onValueChange={handleValueChange}
        disabled={isLoadingTeams || isReinstall}
      >
        <SelectTrigger data-testid={E2eTestId.SelectCredentialTypeTeamDropdown}>
          <SelectValue
            placeholder={
              isLoadingTeams ? "Loading..." : "Select installation type"
            }
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            value={PERSONAL_VALUE}
            disabled={isPersonalDisabled}
            data-testid={E2eTestId.SelectCredentialTypePersonal}
          >
            Myself
            {hasPersonalInstallation && !isReinstall && (
              <span className="text-muted-foreground ml-1">
                (already installed)
              </span>
            )}
          </SelectItem>
          {(isReinstall ? availableTeams : (teams ?? [])).length > 0 && (
            <SelectGroup>
              <SelectLabel>Teams</SelectLabel>
              {(isReinstall ? availableTeams : (teams ?? [])).map((team) => {
                const isAlreadyInstalled =
                  !isReinstall && teamsWithInstallation.includes(team.id);
                return (
                  <SelectItem
                    key={team.id}
                    value={team.id}
                    disabled={areTeamsDisabled || isAlreadyInstalled}
                  >
                    {team.name}
                    {isAlreadyInstalled && (
                      <span className="text-muted-foreground ml-1">
                        (already installed)
                      </span>
                    )}
                  </SelectItem>
                );
              })}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {selectedValue === PERSONAL_VALUE
          ? "Only you can use this server installation"
          : "All members of the selected team can use this server"}
      </p>
    </div>
  );
}
