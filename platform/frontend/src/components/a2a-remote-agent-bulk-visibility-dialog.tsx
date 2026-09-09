"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { useEffect, useState } from "react";
import { A2aRemoteAgentScopeSelector } from "@/components/a2a-remote-agent-scope-selector";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import {
  type A2aRemoteAgent,
  useBulkUpdateA2aRemoteAgentVisibility,
} from "@/lib/a2a-remote-agents.query";
import { reportBulkOutcome } from "@/lib/bulk-action";

export function A2aBulkVisibilityDialog({
  agents,
  open,
  onOpenChange,
  onComplete,
}: {
  agents: A2aRemoteAgent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  const common = commonVisibility(agents);
  const [scope, setScope] = useState<ResourceVisibilityScope>(
    common?.scope ?? "personal",
  );
  const [teamIds, setTeamIds] = useState(common?.teamIds ?? []);
  const [userIds, setUserIds] = useState(common?.userIds ?? []);
  const mutation = useBulkUpdateA2aRemoteAgentVisibility();
  const canApply = scope !== "team" || teamIds.length > 0;

  useEffect(() => {
    if (!open) return;
    const next = commonVisibility(agents);
    setScope(next?.scope ?? "personal");
    setTeamIds(next?.teamIds ?? []);
    setUserIds(next?.userIds ?? []);
  }, [open, agents]);

  const apply = async () => {
    const outcome = await mutation.mutateAsync({
      agents,
      scope,
      teamIds,
      userIds,
    });
    reportBulkOutcome({
      outcome,
      verb: "Updated",
      failureVerb: "update",
      noun: "external A2A agent",
    });
    if (outcome.succeeded.length === 0) return;
    onOpenChange(false);
    if (outcome.failed.length === 0) onComplete();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit visibility"
      description={`Applies to ${agents.length} ${
        agents.length === 1 ? "external A2A agent" : "external A2A agents"
      }${common ? "." : ", which currently have different visibility."}`}
      size="medium"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <A2aRemoteAgentScopeSelector
          scope={scope}
          onScopeChange={setScope}
          teamIds={teamIds}
          onTeamIdsChange={setTeamIds}
          userIds={userIds}
          onUserIdsChange={setUserIds}
        />
      </div>
      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          <span>Cancel</span>
        </Button>
        <Button
          disabled={!canApply || mutation.isPending}
          onClick={() => void apply()}
        >
          <span>{mutation.isPending ? "Applying…" : "Apply"}</span>
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

function commonVisibility(agents: A2aRemoteAgent[]) {
  const [first, ...rest] = agents;
  if (!first) return null;
  const teamIds = first.teams.map((team) => team.id);
  const userIds = first.users.map((user) => user.id);
  const agrees = rest.every(
    (agent) =>
      agent.scope === first.scope &&
      sameIds(
        agent.teams.map((team) => team.id),
        teamIds,
      ) &&
      sameIds(
        agent.users.map((user) => user.id),
        userIds,
      ),
  );
  return agrees ? { scope: first.scope, teamIds, userIds } : null;
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}
