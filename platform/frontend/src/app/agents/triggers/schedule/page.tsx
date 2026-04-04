"use client";

import { Clock, Plus, Trash2, Edit2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useInternalAgents } from "@/lib/agent.query";
import {
  useAgentSchedules,
  useCreateAgentSchedule,
  useUpdateAgentSchedule,
  useDeleteAgentSchedule,
} from "@/lib/agent-schedule.query";
import { toast } from "sonner";

export default function SchedulePage() {
  const { data: agents } = useInternalAgents();
  const { data: schedules, isLoading } = useAgentSchedules();
  const createMutation = useCreateAgentSchedule();
  const updateMutation = useUpdateAgentSchedule();
  const deleteMutation = useDeleteAgentSchedule();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<any>(null);
  const [formData, setFormData] = useState({
    agentId: "",
    cron: "0 * * * *", // Hourly default
    payload: "{}",
    isActive: true,
  });

  const handleOpenDialog = (schedule?: any) => {
    if (schedule) {
      setEditingSchedule(schedule);
      setFormData({
        agentId: schedule.agentId,
        cron: schedule.cron,
        payload: JSON.stringify(schedule.payload, null, 2),
        isActive: schedule.isActive,
      });
    } else {
      setEditingSchedule(null);
      setFormData({
        agentId: agents?.[0]?.id || "",
        cron: "0 * * * *",
        payload: "{}",
        isActive: true,
      });
    }
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      const payloadObj = JSON.parse(formData.payload);
      const data = {
        ...formData,
        payload: payloadObj,
      };

      if (editingSchedule) {
        await updateMutation.mutateAsync({ id: editingSchedule.id, data });
        toast.success("Schedule updated");
      } else {
        await createMutation.mutateAsync(data);
        toast.success("Schedule created");
      }
      setIsDialogOpen(false);
    } catch (e) {
      toast.error("Invalid JSON payload or error saving");
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm("Are you sure?")) {
      await deleteMutation.mutateAsync(id);
      toast.success("Schedule deleted");
    }
  };

  const handleToggle = async (schedule: any) => {
    await updateMutation.mutateAsync({
      id: schedule.id,
      data: { isActive: !schedule.isActive },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Clock className="h-6 w-6" /> Agent Schedules
          </h2>
          <p className="text-muted-foreground text-sm">
            Schedule autonomous agent executions using CRON expressions.
          </p>
        </div>
        <Button onClick={() => handleOpenDialog()}>
          <Plus className="mr-2 h-4 w-4" /> Add Schedule
        </Button>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Cron</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>Last Run</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-10">
                  Loading schedules...
                </TableCell>
              </TableRow>
            ) : !schedules || schedules.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-10 text-muted-foreground">
                  No schedules found. Create your first one!
                </TableCell>
              </TableRow>
            ) : (
              schedules.map((schedule: any) => (
                <TableRow key={schedule.id}>
                  <TableCell className="font-medium">
                    {agents?.find((a) => a.id === schedule.agentId)?.name || schedule.agentId}
                  </TableCell>
                  <TableCell>
                    <code className="bg-muted px-1.5 py-0.5 rounded text-[11px] font-mono">
                      {schedule.cron}
                    </code>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={schedule.isActive}
                      onCheckedChange={() => handleToggle(schedule)}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : "Never"}
                  </TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button variant="ghost" size="icon" onClick={() => handleOpenDialog(schedule)}>
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(schedule.id)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingSchedule ? "Edit Schedule" : "Add Schedule"}</DialogTitle>
            <DialogDescription>
              Configure when and how your agent should be triggered automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="agentId">Agent</Label>
              <select
                id="agentId"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={formData.agentId}
                onChange={(e) => setFormData({ ...formData, agentId: e.target.value })}
              >
                <option value="" disabled>Select an agent</option>
                {agents?.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cron">Cron Expression</Label>
              <Input
                id="cron"
                placeholder="0 * * * *"
                value={formData.cron}
                onChange={(e) => setFormData({ ...formData, cron: e.target.value })}
              />
              <p className="text-[10px] text-muted-foreground italic">
                Format: minute hour day month day-of-week. e.g. "0 * * * *" for every hour.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="payload">Payload (JSON)</Label>
              <textarea
                id="payload"
                className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 font-mono"
                value={formData.payload}
                onChange={(e) => setFormData({ ...formData, payload: e.target.value })}
              />
            </div>
          </DialogBody>
          <DialogFooter className="border-t pt-4">
            <Button variant="outline" size="sm" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!formData.agentId || !formData.cron}>
              {editingSchedule ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
