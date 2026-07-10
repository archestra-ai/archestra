"use client";

import { E2eTestId } from "@archestra/shared";
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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import { useCanModifyCatalogItem } from "./catalog-edit-access";

export type McpServerInstallScope = "personal" | "team" | "org";

type InstallScopeOption = {
  value: McpServerInstallScope;
  label: string;
  disabled: boolean;
  disabledReason?: string;
};

interface SelectMcpServerCredentialTypeAndTeamsProps {
  onTeamChange: (teamId: string | null) => void;
  /** Catalog ID to filter existing installations - if provided, disables already-used options */
  catalogId?: string;
  /** Callback when scope changes (personal vs team vs org) */
  onScopeChange?: (scope: McpServerInstallScope) => void;
  /** When true, this is a reinstall - scope is locked to existing value */
  isReinstall?: boolean;
  /**
   * When true, this is a re-authentication. Like reinstall, the connection's
   * scope cannot change — it is locked to the existing value. Without this the
   * selector treats re-auth as a fresh install and disables the already-used
   * scope ("already installed"), leaving the owner unable to re-authenticate
   * their own connection.
   */
  isReauth?: boolean;
  /** The team ID of the existing server being reinstalled/re-authenticated (null/undefined = personal/org) */
  existingTeamId?: string | null;
  /** The scope of the existing server being reinstalled/re-authenticated */
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
  isReauth = false,
  existingTeamId,
  existingScope,
  personalOnly = false,
  teamOnly = false,
  orgOnly = false,
  onCanInstallChange,
  preselectedTeamId,
}: SelectMcpServerCredentialTypeAndTeamsProps) {
  // Reinstall and re-auth both keep the connection's existing scope — neither
  // picks a new one, so the scope is locked to the existing value rather than
  // disabled because the scope is "already installed".
  const lockToExistingScope = isReinstall || isReauth;
  const { data: installedServers } = useMcpServers();
  const { data: session } = useSession();
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
  // All teams for an install admin, otherwise only the teams the user belongs to.
  const { data: teams, isLoading: isLoadingTeams } = useAssignableTeams({
    isResourceAdmin: !!isMcpServerAdmin,
  });

  // Creating a team-shared install of a `team`-scoped item requires `write` on
  // it (mirrors the backend gate). A `use`-level member lacks it, so the team
  // option is withheld from them — they can still install personally. While the
  // write check is still resolving, don't block: a transient `false` would
  // otherwise steer a genuine write-holder to personal via the self-heal below
  // and never switch back once the check loads.
  //
  // The item is resolved from the (cached) catalog list by id rather than
  // taken as a prop, so every caller that passes `catalogId` is gated — a prop
  // is easy for a caller to forget, silently skipping the gate.
  const { data: catalogItems } = useInternalMcpCatalog();
  const catalogItem = useMemo(
    () =>
      catalogId
        ? (catalogItems?.find((item) => item.id === catalogId) ?? null)
        : null,
    [catalogItems, catalogId],
  );
  const { canModify: canModifyCatalog, isLoading: isCanModifyLoading } =
    useCanModifyCatalogItem(catalogItem);
  const blockTeamForCatalogAccess =
    catalogItem?.scope === "team" && !isCanModifyLoading && !canModifyCatalog;

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
    if (lockToExistingScope) return teams;
    if (!catalogId) return teams;
    return teams.filter((t) => !teamsWithInstallation.includes(t.id));
  }, [teams, catalogId, teamsWithInstallation, lockToExistingScope]);

  const initialScope: McpServerInstallScope = useMemo(() => {
    if (lockToExistingScope) {
      return existingScope ?? (existingTeamId ? "team" : "personal");
    }
    if (orgOnly) return "org";
    if (personalOnly) return "personal";
    if (teamOnly) return "team";
    if (preselectedTeamId) return "team";
    if (hasPersonalInstallation && availableTeams.length > 0) return "team";
    return "personal";
  }, [
    lockToExistingScope,
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
    if (lockToExistingScope) return existingTeamId ?? null;
    if (preselectedTeamId) return preselectedTeamId;
    return null;
  });

  // WHY: During reinstall/re-auth, lock scope to existing value (can't change
  // ownership). Personal is disabled if: reinstalling/re-authing a non-personal
  // server, or (for new install) already has personal or BYOS enabled.
  const isPersonalDisabled =
    teamOnly || orgOnly
      ? true
      : personalOnly
        ? false
        : lockToExistingScope
          ? initialScope !== "personal"
          : hasPersonalInstallation;

  // WHY: Team options are disabled if:
  // 1. personalOnly or orgOnly mode (only that scope is allowed)
  // 2. Reinstalling/re-authing a non-team server (can't switch to team)
  // 3. User lacks mcpServer:update permission (members can never create team installations)
  const isTeamDisabled =
    personalOnly || orgOnly
      ? true
      : lockToExistingScope
        ? initialScope !== "team"
        : !hasMcpServerUpdate ||
          availableTeams.length === 0 ||
          blockTeamForCatalogAccess;

  const isOrgDisabled = personalOnly
    ? true
    : teamOnly
      ? true
      : orgOnly
        ? false
        : lockToExistingScope
          ? initialScope !== "org"
          : !isMcpServerAdmin || hasOrgInstallation;

  const canInstall = !(isPersonalDisabled && isTeamDisabled && isOrgDisabled);

  useEffect(() => {
    onCanInstallChange?.(canInstall);
  }, [canInstall, onCanInstallChange]);

  const visibilityOptions = useMemo<
    Array<InstallScopeOption & VisibilityOption<McpServerInstallScope>>
  >(() => {
    const options: Array<
      InstallScopeOption & VisibilityOption<McpServerInstallScope>
    > = [];

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
          : blockTeamForCatalogAccess
            ? "Sharing this server with a team needs write access to it."
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
    blockTeamForCatalogAccess,
    availableTeams.length,
    teams?.length,
    isMcpServerAdmin,
    hasOrgInstallation,
  ]);

  useEffect(() => {
    if (lockToExistingScope) {
      onScopeChange?.(initialScope);
      onTeamChange(initialScope === "team" ? (existingTeamId ?? null) : null);
      return;
    }

    // Self-heal: if the current scope is disabled (e.g. personal already
    // installed, team option needs a permission the user lacks, etc.), pick
    // the first enabled option. Without this, the SelectValue trigger shows
    // empty because the matching SelectItem is wrapped in a div for the
    // disabledReason tooltip and Radix can't resolve its label.
    const currentOption = visibilityOptions.find((o) => o.value === scope);
    if (currentOption?.disabled) {
      const firstEnabled = visibilityOptions.find((o) => !o.disabled);
      if (firstEnabled && firstEnabled.value !== scope) {
        setScope(firstEnabled.value);
        if (firstEnabled.value === "team") {
          const firstTeam = availableTeams[0]?.id ?? null;
          setSelectedTeamId(firstTeam);
          onScopeChange?.("team");
          onTeamChange(firstTeam);
        } else {
          setSelectedTeamId(null);
          onScopeChange?.(firstEnabled.value);
          onTeamChange(null);
        }
        return;
      }
    }

    onScopeChange?.(scope);
    onTeamChange(scope === "team" ? selectedTeamId : null);
  }, [
    lockToExistingScope,
    initialScope,
    existingTeamId,
    visibilityOptions,
    availableTeams,
    scope,
    selectedTeamId,
    onScopeChange,
    onTeamChange,
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

  // When personalOnly, orgOnly, or preselectedTeamId, skip the scope selector
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
