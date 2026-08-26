"use client";

import { useState } from "react";
import { toast } from "sonner";
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
import { Textarea } from "@/components/ui/textarea";
import { useProfiles } from "@/lib/agent.query";
import { useCreateRunner, useRunnerPreflight } from "@/lib/runners.query";
import { useUpsertUserCredential } from "@/lib/user-credentials.query";

interface StartRunnerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (runnerId: string) => void;
}

export function StartRunnerDialog({
  open,
  onOpenChange,
  onStarted,
}: StartRunnerDialogProps) {
  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });
  const [agentId, setAgentId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const create = useCreateRunner();
  const upsertCredential = useUpsertUserCredential();
  const { data: preflight } = useRunnerPreflight(agentId);

  // Only agents that carry a runner configuration can be started; offering the
  // rest would be offering a button that always fails.
  const runnable = (agents ?? []).filter((agent) => agent.runnerConfig);

  const missing = preflight?.missing ?? [];
  const misconfigured = preflight?.misconfigured ?? [];
  const unfilled = missing.filter((entry) => !secrets[entry.key]?.trim());
  const canStart =
    Boolean(agentId) &&
    name.trim().length > 0 &&
    unfilled.length === 0 &&
    misconfigured.length === 0;

  const start = async () => {
    if (!agentId) return;
    try {
      // Deposit anything the agent asked this person for, then start. Both in
      // one action: being sent to another page to paste a token and coming
      // back is the friction this prompt exists to remove.
      for (const entry of missing) {
        const value = secrets[entry.key]?.trim();
        if (value) {
          await upsertCredential.mutateAsync({ key: entry.key, value });
        }
      }
      const runner = await create.mutateAsync({
        agentId,
        name: name.trim(),
        task: task.trim() || undefined,
      });
      if (runner) {
        toast.success("Runner starting");
        onStarted(runner.id);
        onOpenChange(false);
        setName("");
        setTask("");
        setSecrets({});
      }
    } catch {
      // The mutation reports the reason; nothing useful to add.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Start a runner</DialogTitle>
          <DialogDescription>
            The session runs on your behalf: it uses your credentials, and its
            model usage is attributed to you.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="runner-agent">Agent</Label>
            <Select value={agentId ?? ""} onValueChange={setAgentId}>
              <SelectTrigger id="runner-agent">
                <SelectValue placeholder="Pick an agent" />
              </SelectTrigger>
              <SelectContent>
                {runnable.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {runnable.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No agent has a runner configuration yet. Add one under an
                agent's Advanced settings.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="runner-name">Name</Label>
            <Input
              id="runner-name"
              value={name}
              placeholder="What this session is for"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="runner-task">Task</Label>
            <Textarea
              id="runner-task"
              value={task}
              rows={3}
              placeholder="The first instruction the agent gets"
              onChange={(event) => setTask(event.target.value)}
            />
          </div>

          {missing.length > 0 && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="space-y-0.5">
                <Label>Connect your credentials</Label>
                <p className="text-xs text-muted-foreground">
                  This agent acts with your own identity, so it needs these from
                  you. They are stored for you alone and reused next time.
                </p>
              </div>
              {missing.map((entry) => (
                <div key={entry.key} className="space-y-1">
                  <Label
                    htmlFor={`credential-${entry.key}`}
                    className="text-xs"
                  >
                    {entry.label}
                  </Label>
                  <Input
                    id={`credential-${entry.key}`}
                    type="password"
                    value={secrets[entry.key] ?? ""}
                    onChange={(event) =>
                      setSecrets((previous) => ({
                        ...previous,
                        [entry.key]: event.target.value,
                      }))
                    }
                  />
                  {entry.description && (
                    <p className="text-xs text-muted-foreground">
                      {entry.description}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {misconfigured.length > 0 && (
            <p className="text-xs text-destructive">
              An administrator has to configure this agent's shared credentials
              first: {misconfigured.map((entry) => entry.label).join(", ")}.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void start()}
            disabled={!canStart || create.isPending}
          >
            Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
