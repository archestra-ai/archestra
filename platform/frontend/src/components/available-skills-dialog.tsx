"use client";

import { useState } from "react";
import { AgentActivationSkillsTable } from "@/components/agent-activation-skills-table";
import { GatewayPublishedSkillsTable } from "@/components/gateway-published-skills-table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgentActivationSkills } from "@/lib/agent-skills.query";
import { useSkillsPaginated } from "@/lib/skills/skill.query";

type AvailableSkillsSource =
  | {
      kind: "agent";
      agentId?: string;
      environmentId?: string | null;
    }
  | {
      kind: "gateway";
      gatewayId?: string;
      environmentId?: string | null;
    };

/** The shared “View all N skills” discovery affordance for both policy editors. */
export function AvailableSkillsDialog({
  source,
}: {
  source: AvailableSkillsSource;
}) {
  const [open, setOpen] = useState(false);
  const agentCount = useAgentActivationSkills({
    agentId: source.kind === "agent" ? source.agentId : undefined,
    environmentId: source.kind === "agent" ? source.environmentId : undefined,
    limit: 1,
    offset: 0,
    view: "eligible",
    enabled: source.kind === "agent",
  });
  const gatewayCount = useSkillsPaginated(
    {
      forAgentId: source.kind === "gateway" ? source.gatewayId : undefined,
      mcpGatewayEnvironment:
        source.kind === "gateway"
          ? (source.environmentId ?? "default")
          : undefined,
      limit: 1,
      offset: 0,
      sortBy: "name",
      sortDirection: "asc",
      agentSkillView: "eligible",
    },
    {
      enabled: source.kind === "gateway",
      toastOnError: false,
    },
  );
  const count =
    source.kind === "agent"
      ? agentCount.data?.pagination.total
      : gatewayCount.data?.pagination?.total;
  const label =
    count === undefined
      ? "View all skills"
      : `View all ${count} ${count === 1 ? "skill" : "skills"}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 text-xs font-normal"
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <DialogContent className="h-[80dvh] max-w-5xl sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Skills available in All mode</DialogTitle>
          <DialogDescription>
            This read-only list shows the skills eligible for All mode after
            access, environment, and publication filters. Any exclusions
            configured in All mode still apply.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
          {source.kind === "agent" ? (
            <AgentActivationSkillsTable
              agentId={source.agentId}
              environmentId={source.environmentId}
              view="eligible"
            />
          ) : (
            <GatewayPublishedSkillsTable
              gatewayId={source.gatewayId}
              environmentId={source.environmentId}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
