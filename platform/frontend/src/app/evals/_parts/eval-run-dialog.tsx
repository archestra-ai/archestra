"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProfilesPaginated } from "@/lib/agent.query";
import { useCreateEvalRun } from "@/lib/evals/eval.query";

const AGENT_PICKER_LIMIT = 100;

/** Pick an agent (and optional run label), then start the eval run. */
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
  const [agentId, setAgentId] = useState<string>("");
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
    if (!agentId) return;
    const run = await createRun.mutateAsync({
      suiteId,
      body: { agentId, ...(runName ? { name: runName } : {}) },
    });
    onOpenChange(false);
    setRunName("");
    if (run) router.push(`/evals/runs/${run.id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run eval suite</DialogTitle>
          <DialogDescription>
            Every case is sent to the agent and graded against its assertions.
            The run executes in the background.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Agent</Label>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger>
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            <span>Cancel</span>
          </Button>
          <Button onClick={start} disabled={!agentId || createRun.isPending}>
            <span>{createRun.isPending ? "Starting…" : "Start run"}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
