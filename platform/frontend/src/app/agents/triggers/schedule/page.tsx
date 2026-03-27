"use client";

import {
  AlertCircle,
  Calendar,
  Clock,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Timer,
  Trash2,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useAgentScheduleTriggers,
  useDeleteAgentScheduleTrigger,
  useManualTriggerAgentSchedule,
  useToggleAgentScheduleTrigger,
} from "@/lib/chatops/agent-schedule-trigger.query";
import { formatCronSchedule } from "@/lib/utils/format-cron";
import { CreateScheduleTriggerDialog } from "./_components/create-schedule-trigger-dialog";

export default function SchedulePage() {
  const { data: triggers = [], isLoading } = useAgentScheduleTriggers();
  const deleteMutation = useDeleteAgentScheduleTrigger();
  const toggleMutation = useToggleAgentScheduleTrigger();
  const manualTriggerMutation = useManualTriggerAgentSchedule();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  const formatSchedule = (trigger: (typeof triggers)[0]) => {
    if (trigger.triggerType === "cron" && trigger.cronExpression) {
      return formatCronSchedule(trigger.cronExpression);
    }
    if (trigger.triggerType === "interval" && trigger.intervalSeconds) {
      const mins = Math.floor(trigger.intervalSeconds / 60);
      const hrs = Math.floor(mins / 60);
      if (hrs > 0) return `Every ${hrs}h ${mins % 60}m`;
      return `Every ${mins}m`;
    }
    if (trigger.triggerType === "one_time" && trigger.scheduledAt) {
      return new Date(trigger.scheduledAt).toLocaleString();
    }
    return "—";
  };

  const triggerTypeIcon = (type: string) => {
    switch (type) {
      case "cron":
        return <Clock className="h-4 w-4" />;
      case "interval":
        return <Timer className="h-4 w-4" />;
      case "one_time":
        return <Calendar className="h-4 w-4" />;
      default:
        return null;
    }
  };

  const triggerTypeLabel = (type: string) => {
    switch (type) {
      case "cron":
        return "Cron";
      case "interval":
        return "Interval";
      case "one_time":
        return "One-time";
      default:
        return type;
    }
  };

  return (
    <div className="space-y-4">
      {/* How It Works */}
      <Card>
        <CardHeader>
          <CardTitle>How It Works</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            Schedule triggers allow agents to run automatically on a recurring
            or one-time basis. Create cron-based schedules for complex timing,
            fixed intervals for regular checks, or one-time triggers for
            deferred execution.
          </p>
          <p>
            The system evaluates due triggers every 60 seconds and queues agent
            executions through the task queue for reliable delivery with
            automatic retry.
          </p>
        </CardContent>
      </Card>

      {/* Triggers Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle>Schedule Triggers</CardTitle>
          <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Create Trigger
          </Button>
        </CardHeader>
        <CardContent>
          {triggers.length === 0 ? (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>No Schedule Triggers</AlertTitle>
              <AlertDescription>
                Create a schedule trigger to run agents automatically on a
                schedule.
              </AlertDescription>
            </Alert>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Run</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  <TableHead className="w-[50px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {triggers.map((trigger) => (
                  <TableRow key={trigger.id}>
                    <TableCell className="font-medium">
                      {trigger.name}
                      {trigger.lastError && (
                        <p className="text-xs text-destructive mt-0.5 truncate max-w-[200px]">
                          {trigger.lastError}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        {triggerTypeIcon(trigger.triggerType)}
                        {triggerTypeLabel(trigger.triggerType)}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                      {formatSchedule(trigger)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={trigger.enabled ? "default" : "secondary"}
                      >
                        {trigger.enabled ? "Active" : "Disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {trigger.lastExecutedAt
                        ? new Date(trigger.lastExecutedAt).toLocaleString()
                        : "Never"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {trigger.executionCount}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              manualTriggerMutation.mutate(trigger.id)
                            }
                          >
                            <Zap className="h-4 w-4 mr-2" />
                            Run Now
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              toggleMutation.mutate({
                                id: trigger.id,
                                enable: !trigger.enabled,
                              })
                            }
                          >
                            {trigger.enabled ? (
                              <>
                                <Pause className="h-4 w-4 mr-2" />
                                Disable
                              </>
                            ) : (
                              <>
                                <Play className="h-4 w-4 mr-2" />
                                Enable
                              </>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => deleteMutation.mutate(trigger.id)}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CreateScheduleTriggerDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
    </div>
  );
}
