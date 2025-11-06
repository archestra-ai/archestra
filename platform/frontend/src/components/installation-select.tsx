"use client";

import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentAvailableTokens } from "@/lib/mcp-server.query";
import { cn } from "@/lib/utils";

interface InstallationSelectProps {
  value?: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
  /** Catalog ID to filter installations - only shows local installations for the same catalog item */
  catalogId: string;
  /** Agent IDs to filter installations - only shows installations that can be used with the specified agents */
  agentIds: string[];
}

/**
 * Self-contained component for selecting execution source (pod) for local MCP tool execution.
 * Shows local MCP server installations for a given catalog item with team-based filtering.
 *
 * Filtering logic:
 * - Personal installations: shown if user is owner AND shares team with agent
 * - Team installations: shown if any installation team matches agent teams
 * - Admins: see all installations
 */
export function InstallationSelect({
  value,
  onValueChange,
  disabled,
  className,
  catalogId,
  agentIds,
}: InstallationSelectProps) {
  const { data: mcpServers, isLoading } = useAgentAvailableTokens({
    agentIds: agentIds ?? null,
    catalogId: catalogId ?? null,
  });

  // Filter to local servers only (check serverType exists since hook returns different types)
  const installations = mcpServers?.filter(
    (server) => "serverType" in server && server.serverType === "local",
  );

  // Separate team and personal installations
  const teamInstallations = installations?.filter(
    (server) => server.authType === "team",
  );
  const personalInstallations = installations?.filter(
    (server) => server.authType === "personal",
  );

  return (
    <Select
      value={value || undefined}
      onValueChange={onValueChange}
      disabled={disabled || isLoading}
    >
      <SelectTrigger
        className={cn(
          "h-fit! w-fit! bg-transparent! border-none! shadow-none! ring-0! outline-none! focus:ring-0! focus:outline-none! focus:border-none! p-0!",
          className,
        )}
        size="sm"
      >
        <SelectValue placeholder="Select installation..." />
      </SelectTrigger>
      <SelectContent>
        {teamInstallations && teamInstallations.length > 0 && (
          <SelectGroup>
            <SelectLabel>Team installations</SelectLabel>
            {teamInstallations.map((server) => (
              <SelectItem
                key={server.id}
                value={server.id}
                className="cursor-pointer"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">
                      {server.ownerEmail || "Unknown owner"}
                    </span>
                  </div>
                  {server.teamDetails && server.teamDetails.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {server.teamDetails.map((team) => (
                        <Badge
                          key={team.teamId}
                          variant="secondary"
                          className="text-[10px] px-1 py-0"
                        >
                          {team.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {personalInstallations && personalInstallations.length > 0 && (
          <SelectGroup>
            <SelectLabel>Personal installations</SelectLabel>
            {personalInstallations.map((server) => (
              <SelectItem
                key={server.id}
                value={server.id}
                className="cursor-pointer"
              >
                <span className="text-xs">
                  {server.ownerEmail || "Unknown owner"}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {(!installations || installations.length === 0) && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No installations available
          </div>
        )}
      </SelectContent>
    </Select>
  );
}
