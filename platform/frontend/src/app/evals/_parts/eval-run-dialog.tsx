"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { useProfilesPaginated } from "@/lib/agent.query";
import { useCreateEvalRun } from "@/lib/evals/eval.query";

const AGENT_PICKER_LIMIT = 100;
const MAX_AGENTS_PER_RUN = 10;

/** Pick one or more agents (and an optional label), then start the eval run. */
export function EvalRunDialog({
  open,
  onOpenChange,
  suiteId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suiteId: string;
}) {
  const router = useRouter();
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [runName, setRunName] = useState("");
  const createRun = useCreateEvalRun();

  const agentsQuery = useProfilesPaginated({
    agentTypes: ["agent"],
    limit: AGENT_PICKER_LIMIT,
    sortBy: "name",
    sortDirection: "asc",
  });
  const agents = agentsQuery.data?.data ?? [];

  const start = async () => {
    if (agentIds.length === 0) return;
    const runs = await createRun.mutateAsync({
      suiteId,
      body: { agentIds, ...(runName ? { name: runName } : {}) },
    });
    onOpenChange(false);
    setRunName("");
    setAgentIds([]);
    if (!runs || runs.length === 0) return;
    if (runs.length === 1) {
      router.push(`/evals/runs/${runs[0].id}`);
    } else {
      // A comparison group lands on the suite's Runs tab, focused on itself.
      router.push(`/evals/${suiteId}?tab=runs&group=${runs[0].groupId}`);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Run eval suite"
      description="Every case is sent to each agent and graded against its assertions. Runs execute in the background."
      size="small"
    >
      <DialogForm onSubmit={() => void start()}>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label>Agents</Label>
            <MultiSelectCombobox
              options={agents.map((agent) => ({
                value: agent.id,
                label: agent.name,
              }))}
              value={agentIds}
              onChange={(value) =>
                setAgentIds(value.slice(0, MAX_AGENTS_PER_RUN))
              }
              placeholder="Select agents…"
              emptyMessage="No agents found."
            />
            <p className="text-muted-foreground text-xs">
              Pick several agents to compare them side by side on the same
              cases.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="eval-run-name">Run label</Label>
            <Input
              id="eval-run-name"
              placeholder="e.g. nightly-2026-08-25 (optional)"
              value={runName}
              onChange={(event) => setRunName(event.target.value)}
              maxLength={200}
            />
          </div>
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={agentIds.length === 0 || createRun.isPending}
          >
            <span>
              {createRun.isPending
                ? "Starting…"
                : agentIds.length > 1
                  ? `Start ${agentIds.length} runs`
                  : "Start run"}
            </span>
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
