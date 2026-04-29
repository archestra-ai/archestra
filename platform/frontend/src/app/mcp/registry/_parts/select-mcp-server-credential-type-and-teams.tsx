"use client";

import { E2eTestId } from "@shared";
import { AlertTriangle, Globe, Lock, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useTeams } from "@/lib/teams/team.query";

export type McpServerInstallScope = "personal" | "team" | "org";

interface SelectMcpServerCredentialTypeAndTeamsProps {
  onTeamChange: (teamId: string | null) => void;
  /** Catalog ID to filter existing installations - if provided, disables already-used options */
  catalogId?: string;
  /** Callback when scope changes (personal vs team vs org) */
  onScopeChange?: (scope: McpServerInstallScope) => void;
  /** When true, this is a reinstall - scope is locked to existing value */
  isReinstall?: boolean;
  /** The team ID of the existing server being reinstalled (null/undefined = personal/org) */
  existingTeamId?: string | null;
  /** The scope of the existing server being reinstalled */
  existingScope?: McpServerInstallScope;
  /** When true, only personal installation is allowed */
  personalOnly?: boolean;
  /** When true, only team installation is allowed */
  teamOnly?: boolean;
  /** When true, only organization installation is allowed */
  orgOnly?: boolean;
  /** Callback when install availability changes */
  onCanInstallChange?: (canInstall: boolean) => void;
  /** Pre-select a specific team (used when adding shared connection from manage dialog) */
  preselectedTeamId?: string | null;
}

export function SelectMcpServerCredentialTypeAndTeams({
  onTeamChange,
  catalogId,
  onScopeChange,
  isReinstall = false,
  existingTeamId,
  existingScope,
  personalOnly = false,
  teamOnly = false,
  orgOnly = false,
  onCanInstallChange,
  preselectedTeamId,
}: SelectMcpServerCredentialTypeAndTeamsProps) {
  const { data: teams, isLoading: isLoadingTeams } = useTeams();
  const { data: installedServers } = useMcpServers();
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;

  // WHY: Check mcpServer:update permission to determine if user can create team installations
  // Editors have this permission, members don't. This prevents members from installing
  // MCP servers that affect the whole team - only editors and admins can do that.
  const { data: hasMcpServerUpdate } = useHasPermissions({
    mcpServerInstallation: ["update"],
  });
  // WHY: mcpServerInstallation:admin gates org-wide installations
  const { data: isMcpServerAdmin } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });

  const { hasPersonalInstallation, teamsWithInstallation, hasOrgInstallation } =
    useMemo(() => {
      if (!catalogId || !installedServers) {
        return {
          hasPersonalInstallation: false,
          teamsWithInstallation: [] as string[],
          hasOrgInstallation: false,
        };
      }

      const serversForCatalog = installedServers.filter(
        (s) => s.catalogId === catalogId,
      );

      const hasPersonal = serversForCatalog.some((s) => {
        const scope = s.scope ?? (s.teamId ? "team" : "personal");
        return scope === "personal" && s.ownerId === currentUserId;
      });

      const hasOrg = serversForCatalog.some((s) => s.scope === "org");

      const teamIds = serversForCatalog
        .filter((s) => {
          const scope = s.scope ?? (s.teamId ? "team" : "personal");
          return scope === "team" && !!s.teamId;
        })
        .map((s) => s.teamId as string);

      return {
        hasPersonalInstallation: hasPersonal,
        teamsWithInstallation: teamIds,
        hasOrgInstallation: hasOrg,
      };
    }, [catalogId, installedServers, currentUserId]);

  const availableTeams = useMemo(() => {
    if (!teams) return [];
    if (isReinstall) return teams;
    if (!catalogId) return teams;
    return teams.filter((t) => !teamsWithInstallation.includes(t.id));
  }, [teams, catalogId, teamsWithInstallation, isReinstall]);

  const initialScope: McpServerInstallScope = useMemo(() => {
    if (isReinstall) {
      return existingScope ?? (existingTeamId ? "team" : "personal");
    }
    if (orgOnly) return "org";
    if (personalOnly) return "personal";
    if (teamOnly) return "team";
    if (preselectedTeamId) return "team";
    if (hasPersonalInstallation && availableTeams.length > 0) return "team";
    return "personal";
  }, [
    isReinstall,
    existingScope,
    existingTeamId,
    orgOnly,
    personalOnly,
    teamOnly,
    preselectedTeamId,
    hasPersonalInstallation,
    availableTeams.length,
  ]);

  const [scope, setScope] = useState<McpServerInstallScope>(initialScope);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(() => {
    if (isReinstall) return existingTeamId ?? null;
    if (preselectedTeamId) return preselectedTeamId;
    return null;
  });

  // WHY: During reinstall, lock scope to existing value (can't change ownership).
  // Personal is disabled if: reinstalling a non-personal server, or (for new install)
  // already has personal or BYOS enabled.
  const isPersonalDisabled =
    teamOnly || orgOnly
      ? true
      : personalOnly
        ? false
        : isReinstall
          ? initialScope !== "personal"
          : hasPersonalInstallation;

  // WHY: Team options are disabled if:
  // 1. personalOnly or orgOnly mode (only that scope is allowed)
  // 2. Reinstalling a non-team server (can't switch to team)
  // 3. User lacks mcpServer:update permission (members can never create team installations)
  const isTeamDisabled =
    personalOnly || orgOnly
      ? true
      : isReinstall
        ? initialScope !== "team"
        : !hasMcpServerUpdate || availableTeams.length === 0;

  const isOrgDisabled = personalOnly
    ? true
    : teamOnly
      ? true
      : orgOnly
        ? false
        : isReinstall
          ? initialScope !== "org"
          : !isMcpServerAdmin || hasOrgInstallation;

  const canInstall = !(isPersonalDisabled && isTeamDisabled && isOrgDisabled);

  useEffect(() => {
    onCanInstallChange?.(canInstall);
  }, [canInstall, onCanInstallChange]);

  useEffect(() => {
    if (isReinstall) {
      onScopeChange?.(initialScope);
      onTeamChange(initialScope === "team" ? (existingTeamId ?? null) : null);
      return;
    }

    if (hasPersonalInstallation && scope === "personal") {
      if (availableTeams.length > 0) {
        setScope("team");
        setSelectedTeamId(availableTeams[0].id);
        onScopeChange?.("team");
        onTeamChange(availableTeams[0].id);
        return;
      }
      if (!isOrgDisabled) {
        setScope("org");
        setSelectedTeamId(null);
        onScopeChange?.("org");
        onTeamChange(null);
        return;
      }
    }

    onScopeChange?.(scope);
    onTeamChange(scope === "team" ? selectedTeamId : null);
  }, [
    isReinstall,
    initialScope,
    existingTeamId,
    hasPersonalInstallation,
    availableTeams,
    scope,
    selectedTeamId,
    isOrgDisabled,
    onScopeChange,
    onTeamChange,
  ]);

  const visibilityOptions = useMemo<
    Array<VisibilityOption<McpServerInstallScope>>
  >(() => {
    const options: Array<VisibilityOption<McpServerInstallScope>> = [];

    if (!teamOnly) {
      options.push({
        value: "personal",
        label: "Personal",
        description:
          "Only you can use this connection. Admins can still assign it.",
        icon: Lock,
        disabled: isPersonalDisabled,
        disabledReason: hasPersonalInstallation
          ? "You have already installed this server personally"
          : teamOnly
            ? "Only team installation is allowed here"
            : undefined,
      });
    }

    if (!personalOnly) {
      options.push({
        value: "team",
        label: "Team",
        description: "Available to members of one selected team.",
        icon: Users,
        disabled: isTeamDisabled,
        disabledReason: !hasMcpServerUpdate
          ? "You need mcpServerInstallation:update to share with a team"
          : availableTeams.length === 0
            ? teams?.length === 0
              ? "Create a team first to share this connection"
              : "All teams already have this server installed"
            : undefined,
      });
    }

    if (!personalOnly && !teamOnly) {
      options.push({
        value: "org",
        label: "Organization",
        description: "Available to everyone in the organization.",
        icon: Globe,
        disabled: isOrgDisabled,
        disabledReason: !isMcpServerAdmin
          ? "You need mcpServerInstallation:admin to install organization-wide"
          : hasOrgInstallation
            ? "An organization-wide installation already exists"
            : undefined,
      });
    }

    return options;
  }, [
    teamOnly,
    personalOnly,
    isPersonalDisabled,
    isTeamDisabled,
    isOrgDisabled,
    hasPersonalInstallation,
    hasMcpServerUpdate,
    availableTeams.length,
    teams?.length,
    isMcpServerAdmin,
    hasOrgInstallation,
  ]);

  const handleScopeChange = (next: McpServerInstallScope) => {
    setScope(next);
    if (next === "team") {
      const firstAvailable = availableTeams[0]?.id ?? null;
      setSelectedTeamId((current) => current ?? firstAvailable);
    } else {
      setSelectedTeamId(null);
    }
  };

  if (!canInstall) {
    return (
      <Alert>
        <AlertTriangle className="!text-amber-500 h-4 w-4" />
        <AlertDescription>
          <span className="font-semibold">Already installed</span>
          <p className="mt-1">
            This MCP server is already installed everywhere you have permission
            to install it.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  // When personalOnly, orgOnly, or preselectedTeamId, skip the selector
  // entirely — scope is fixed.
  if (personalOnly || orgOnly || preselectedTeamId) {
    return null;
  }

  const hideSelector = isReinstall || visibilityOptions.length <= 1;

  return (
    <div
      className="space-y-4"
      data-testid={E2eTestId.SelectCredentialTypeTeamDropdown}
    >
      {!hideSelector && (
        <VisibilitySelector
          label="Install for"
          value={scope}
          options={visibilityOptions}
          onValueChange={handleScopeChange}
        />
      )}

      {scope === "team" && (
        <div className="space-y-2">
          <Label>Team</Label>
          <Select
            value={selectedTeamId ?? ""}
            onValueChange={(value) => setSelectedTeamId(value)}
            disabled={isLoadingTeams || isReinstall}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={isLoadingTeams ? "Loading..." : "Select a team"}
              />
            </SelectTrigger>
            <SelectContent>
              {(isReinstall ? (teams ?? []) : availableTeams).map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
