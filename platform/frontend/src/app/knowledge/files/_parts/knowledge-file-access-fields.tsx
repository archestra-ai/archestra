"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { AgentSelector } from "@/components/agent-selector";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useProfiles } from "@/lib/agent.query";
import { useTeams } from "@/lib/teams/team.query";

const VISIBILITY_OPTIONS: Record<
  ResourceVisibilityScope,
  VisibilityOption<ResourceVisibilityScope>
> = {
  personal: {
    value: "personal",
    label: "Owner",
    description: "Only you can view and query this file",
    icon: User,
  },
  team: {
    value: "team",
    label: "Teams",
    description: "Share this file with selected teams",
    icon: Users,
  },
  org: {
    value: "org",
    label: "Organization",
    description: "Anyone in your org can view and query this file",
    icon: Globe,
  },
};

export function KnowledgeFileAccessFields({
  visibility,
  onVisibilityChange,
  teamIds,
  onTeamIdsChange,
  agentIds,
  onAgentIdsChange,
  defaultToAllAgents = false,
}: {
  visibility: ResourceVisibilityScope;
  onVisibilityChange: (visibility: ResourceVisibilityScope) => void;
  teamIds: string[];
  onTeamIdsChange: (teamIds: string[]) => void;
  agentIds: string[];
  onAgentIdsChange: (agentIds: string[]) => void;
  defaultToAllAgents?: boolean;
}) {
  const initializedDefaultAgentsRef = useRef(false);
  const { data: teams } = useTeams();
  const { data: agents } = useProfiles({
    filters: { agentTypes: ["agent", "mcp_gateway"] },
  });
  const allAgentIds = useMemo(
    () => (agents ?? []).map((agent) => agent.id),
    [agents],
  );

  useEffect(() => {
    if (initializedDefaultAgentsRef.current || !defaultToAllAgents) {
      return;
    }

    if (allAgentIds.length === 0 || agentIds.length > 0) {
      return;
    }

    initializedDefaultAgentsRef.current = true;
    onAgentIdsChange(allAgentIds);
  }, [agentIds.length, allAgentIds, defaultToAllAgents, onAgentIdsChange]);

  const options = Object.values(VISIBILITY_OPTIONS).map((option) => ({
    ...option,
    disabled: option.value === "team" && (teams ?? []).length === 0,
    disabledLabel:
      option.value === "team" && (teams ?? []).length === 0
        ? "No teams available"
        : undefined,
  }));

  return (
    <div className="space-y-5">
      <VisibilitySelector
        value={visibility}
        description="Controls who can see this file and retrieve it through assigned agents or MCP gateways."
        options={options}
        onValueChange={onVisibilityChange}
      >
        {visibility === "team" && (
          <div className="space-y-2">
            <Label>Teams</Label>
            <MultiSelectCombobox
              options={(teams ?? []).map((team) => ({
                value: team.id,
                label: team.name,
              }))}
              value={teamIds}
              onChange={onTeamIdsChange}
              placeholder="Search teams..."
              emptyMessage="No teams found."
            />
          </div>
        )}
      </VisibilitySelector>

      <div className="space-y-2">
        <div className="space-y-1">
          <Label>Agents / MCP Gateways</Label>
          <p className="text-xs text-muted-foreground">
            Choose which agents and MCP gateways can retrieve this file, or make
            it available to all of them.
          </p>
        </div>
        <AgentSelector
          mode="multiple"
          agents={agents ?? []}
          value={agentIds}
          onValueChange={onAgentIdsChange}
          placeholder="Search agents and MCP gateways..."
          emptyMessage="No agents or MCP gateways found."
          allOption={{ label: "All agents and MCP gateways" }}
        />
      </div>
    </div>
  );
}
