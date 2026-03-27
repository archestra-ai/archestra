"use client";

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
import { Textarea } from "@/components/ui/textarea";
import { useProfiles } from "@/lib/agent.query";
import { useCreateAgentScheduleTrigger } from "@/lib/chatops/agent-schedule-trigger.query";

type TriggerType = "cron" | "interval" | "one_time";

export function CreateScheduleTriggerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createMutation = useCreateAgentScheduleTrigger();
  const { data: agents = [] } = useProfiles({
    filters: { agentTypes: ["agent"] },
  });

  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [triggerType, setTriggerType] = useState<TriggerType>("cron");
  const [cronExpression, setCronExpression] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [scheduledAt, setScheduledAt] = useState("");
  const [message, setMessage] = useState("");

  const resetForm = () => {
    setName("");
    setAgentId("");
    setTriggerType("cron");
    setCronExpression("");
    setIntervalMinutes("60");
    setScheduledAt("");
    setMessage("");
  };

  const isValid = () => {
    if (!name.trim() || !agentId) return false;
    if (triggerType === "cron" && !cronExpression.trim()) return false;
    if (
      triggerType === "interval" &&
      (!intervalMinutes || Number(intervalMinutes) < 1)
    )
      return false;
    if (triggerType === "one_time" && !scheduledAt) return false;
    return true;
  };

  const handleSubmit = async () => {
    if (!isValid()) return;

    const body: Parameters<typeof createMutation.mutateAsync>[0] = {
      agentId,
      name: name.trim(),
      triggerType,
      message: message.trim() || undefined,
    };

    if (triggerType === "cron") {
      body.cronExpression = cronExpression.trim();
    } else if (triggerType === "interval") {
      body.intervalSeconds = Number(intervalMinutes) * 60;
    } else if (triggerType === "one_time") {
      body.scheduledAt = new Date(scheduledAt).toISOString();
    }

    const result = await createMutation.mutateAsync(body);
    if (result) {
      resetForm();
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Schedule Trigger</DialogTitle>
          <DialogDescription>
            Set up an automated schedule for an agent to run.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              placeholder="Daily report generation"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="agent">Agent</Label>
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
            <Label htmlFor="triggerType">Schedule Type</Label>
            <Select
              value={triggerType}
              onValueChange={(v) => setTriggerType(v as TriggerType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cron">Cron Expression</SelectItem>
                <SelectItem value="interval">Fixed Interval</SelectItem>
                <SelectItem value="one_time">One-time</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {triggerType === "cron" && (
            <div className="space-y-2">
              <Label htmlFor="cron">Cron Expression</Label>
              <Input
                id="cron"
                placeholder="0 9 * * *"
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Standard cron syntax: minute hour day month weekday (e.g.,{" "}
                <code className="bg-muted px-1 rounded">0 9 * * 1-5</code> for
                weekdays at 9am)
              </p>
            </div>
          )}

          {triggerType === "interval" && (
            <div className="space-y-2">
              <Label htmlFor="interval">Interval (minutes)</Label>
              <Input
                id="interval"
                type="number"
                min="1"
                placeholder="60"
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Minimum 1 minute. The agent will run repeatedly at this
                interval.
              </p>
            </div>
          )}

          {triggerType === "one_time" && (
            <div className="space-y-2">
              <Label htmlFor="scheduledAt">Scheduled At</Label>
              <Input
                id="scheduledAt"
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The agent will run once at this time and the trigger will be
                automatically disabled.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="message">
              Message{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </Label>
            <Textarea
              id="message"
              placeholder="Provide context for the agent execution..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              This message is sent to the agent as the input when the schedule
              fires.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid() || createMutation.isPending}
          >
            {createMutation.isPending ? "Creating..." : "Create Trigger"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
