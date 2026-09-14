"use client";

import { useState } from "react";
import { AgentActivationSkillsTable } from "@/components/agent-activation-skills-table";
import type { EditableSkill } from "@/components/agent-skills-editor";
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

type AvailableSkillsSource =
  | {
      kind: "agent";
      agentId?: string;
      environmentId?: string | null;
      excludedIds: string[];
    }
  | {
      kind: "gateway";
      skills: EditableSkill[];
      excludedIds: string[];
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
  const count =
    source.kind === "agent"
      ? agentCount.data
        ? Math.max(
            0,
            agentCount.data.pagination.total - source.excludedIds.length,
          )
        : undefined
      : source.skills.filter((skill) => !source.excludedIds.includes(skill.id))
          .length;
  const label =
    count === undefined
      ? "View all skills"
      : count === 1
        ? "View 1 Skill"
        : `View all ${count} skills`;

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
            {source.kind === "agent"
              ? "This read-only list shows skills available after access, environment, and policy filters."
              : "This read-only list shows organization skills published by All mode after exclusions."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
          {source.kind === "agent" ? (
            <AgentActivationSkillsTable
              agentId={source.agentId}
              environmentId={source.environmentId}
              view="eligible"
              excludedIds={source.excludedIds}
            />
          ) : (
            <GatewayPublishedSkillsTable
              skills={source.skills}
              excludedIds={source.excludedIds}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
