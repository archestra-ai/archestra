"use client";

import {
  type AgentScope,
  type archestraApiTypes,
  getResourceForAgentType,
} from "@archestra/shared";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AccessLevelSelector,
  agentTypeDisplayName,
} from "@/components/agent-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCloneAgent } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAssignableTeams } from "@/lib/teams/team.query";

type CloneSourceAgent = Pick<
  archestraApiTypes.GetAgentsResponses["200"]["data"][number],
  "id" | "name" | "agentType" | "scope" | "teams"
>;

type CloneAgentDialogProps = {
  /** Agent / MCP gateway / LLM proxy to clone; null keeps the dialog closed. */
  agent: CloneSourceAgent | null;
  onOpenChange: (open: boolean) => void;
  /** Called with the newly created clone (e.g. to open its edit dialog). */
  onCloned?: (cloned: archestraApiTypes.CloneAgentResponses["200"]) => void;
};

/**
 * Confirms a clone and lets the user pick the copy's visibility before it is
 * created. Defaults to the source's visibility, downgraded to "personal" when
 * the user lacks the permission to recreate it (the clone is a new object, so
 * the same rules as creation apply).
 */
export function CloneAgentDialog({
  agent,
  onOpenChange,
  onCloned,
}: CloneAgentDialogProps) {
  const cloneAgent = useCloneAgent();

  const resource = getResourceForAgentType(agent?.agentType ?? "agent");
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: isAdmin } = useHasPermissions({ [resource]: ["admin"] });
  const { data: isTeamAdmin } = useHasPermissions({
    [resource]: ["team-admin"],
  });
  // Picker offers all teams to a full resource-admin, otherwise only the teams
  // the user belongs to (the only ones the backend lets a team-admin assign).
  const { data: teams } = useAssignableTeams({
    isResourceAdmin: !!isAdmin,
    enabled: agent !== null && !!canReadTeams,
  });

  const [scope, setScope] = useState<AgentScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  // Start from the source's visibility whenever a new agent is picked
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the target changes
  useEffect(() => {
    if (!agent) return;
    setScope(agent.scope);
    setTeamIds(agent.teams.map((team) => team.id));
  }, [agent?.id]);

  // Fall back to personal when the source's visibility isn't one the user can
  // grant to a new object (permission data resolves asynchronously)
  useEffect(() => {
    if (isAdmin === undefined || isTeamAdmin === undefined) return;
    setScope((prev) => {
      if (prev === "org" && !isAdmin) return "personal";
      if (prev === "team" && !isAdmin && !isTeamAdmin) return "personal";
      return prev;
    });
  }, [isAdmin, isTeamAdmin]);

  // Drop preselected teams the user cannot assign (the backend rejects them)
  useEffect(() => {
    if (!teams) return;
    const assignable = new Set(teams.map((team) => team.id));
    setTeamIds((prev) => prev.filter((id) => assignable.has(id)));
  }, [teams]);

  // A team-scoped agent must have at least one team, otherwise it is
  // inaccessible to everyone (issue #6624). Applies to admins too.
  const requiresTeamSelection = scope === "team" && teamIds.length === 0;

  const handleSubmit = async () => {
    if (!agent) return;
    if (requiresTeamSelection) {
      toast.error("Please select at least one team");
      return;
    }
    try {
      const cloned = await cloneAgent.mutateAsync({
        id: agent.id,
        scope,
        teams: scope === "team" ? teamIds : [],
      });
      if (cloned) {
        onOpenChange(false);
        onCloned?.(cloned);
      }
    } catch (_error) {
      // The mutation already surfaced the API error as a toast
    }
  };

  const displayName = agentTypeDisplayName[agent?.agentType ?? "agent"];

  return (
    <Dialog open={agent !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clone {displayName}</DialogTitle>
          <DialogDescription>
            {agent
              ? `Creates a copy of "${agent.name}" with the same configuration.`
              : null}
          </DialogDescription>
        </DialogHeader>

        {agent ? (
          <DialogForm onSubmit={handleSubmit}>
            <DialogBody>
              <AccessLevelSelector
                scope={scope}
                onScopeChange={setScope}
                isAdmin={!!isAdmin}
                isTeamAdmin={!!isTeamAdmin}
                canReadTeams={!!canReadTeams}
                agentType={agent.agentType}
                teams={teams}
                assignedTeamIds={teamIds}
                onTeamIdsChange={setTeamIds}
                hasNoAvailableTeams={!teams || teams.length === 0}
                showTeamRequired={scope === "team"}
              />
            </DialogBody>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={cloneAgent.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={cloneAgent.isPending || requiresTeamSelection}
              >
                {cloneAgent.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                Clone
              </Button>
            </DialogFooter>
          </DialogForm>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
