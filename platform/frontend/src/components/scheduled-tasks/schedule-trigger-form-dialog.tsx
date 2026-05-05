"use client";

import type { ScheduleTriggerReplyChannel } from "@shared";
import { Cron } from "croner";
import { Loader2, MessageCircle, Slack } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const FALLBACK_REPLY_CHANNELS: ScheduleTriggerReplyChannel[] = ["chat"];

export type ScheduleTriggerAgentOption = {
  value: string;
  label: string;
  description?: string;
  content?: React.ReactNode;
};

export type ScheduleTriggerFormValues = {
  name: string;
  agentId: string;
  replyChannel: ScheduleTriggerReplyChannel;
  cronExpression: string;
  timezone: string;
  messageTemplate: string;
  enabled?: boolean;
};

export function ScheduleTriggerFormDialog({
  open,
  onOpenChange,
  title,
  values,
  agentOptions,
  agentsLoading,
  hasAgents,
  isSaving,
  isFormValid,
  permissions,
  submitLabel,
  onSubmit,
  onNameChange,
  onAgentChange,
  onReplyChannelChange,
  onCronExpressionChange,
  onTimezoneChange,
  onEnabledChange,
  onMessageTemplateChange,
  availableReplyChannels,
  showTimezone,
  showEnabled,
  promptLabel = "Task Prompt",
  promptDescription,
  promptHeaderExtra,
  promptPlaceholder,
  promptBody,
  promptLoading = false,
  agentSelectDisabled,
  agentSelectHelpText,
  postEnabledSection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  values: ScheduleTriggerFormValues;
  agentOptions: ScheduleTriggerAgentOption[];
  agentsLoading: boolean;
  hasAgents: boolean;
  isSaving: boolean;
  isFormValid: boolean;
  permissions: { scheduledTask: Array<"create" | "update"> };
  submitLabel: string;
  onSubmit: () => void;
  onNameChange: (value: string) => void;
  onAgentChange: (value: string) => void;
  onReplyChannelChange?: (value: ScheduleTriggerReplyChannel) => void;
  onCronExpressionChange: (value: string) => void;
  onTimezoneChange?: (value: string) => void;
  onEnabledChange?: (value: boolean) => void;
  onMessageTemplateChange: (value: string) => void;
  availableReplyChannels?: ScheduleTriggerReplyChannel[];
  showTimezone?: boolean;
  showEnabled?: boolean;
  promptLabel?: string;
  promptDescription?: React.ReactNode;
  promptHeaderExtra?: React.ReactNode;
  promptPlaceholder?: string;
  promptBody?: React.ReactNode;
  promptLoading?: boolean;
  agentSelectDisabled?: boolean;
  agentSelectHelpText?: string;
  postEnabledSection?: React.ReactNode;
}) {
  const channels = useMemo(
    () => availableReplyChannels ?? FALLBACK_REPLY_CHANNELS,
    [availableReplyChannels],
  );
  const shouldShowReplyChannel = channels.length > 1 && !!onReplyChannelChange;

  useEffect(() => {
    if (!shouldShowReplyChannel) {
      if (values.replyChannel !== "chat" && onReplyChannelChange) {
        onReplyChannelChange("chat");
      }
      return;
    }

    if (!channels.includes(values.replyChannel)) {
      onReplyChannelChange?.("chat");
    }
  }, [
    channels,
    onReplyChannelChange,
    shouldShowReplyChannel,
    values.replyChannel,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={onSubmit}
        >
          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="dialog-name">Name</Label>
              <Input
                id="dialog-name"
                value={values.name}
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="e.g. Daily summary"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="dialog-agent">Agent</Label>
              <SearchableSelect
                value={values.agentId}
                onValueChange={onAgentChange}
                items={agentOptions}
                placeholder="Select agent"
                searchPlaceholder="Search agents..."
                disabled={agentsLoading || !hasAgents || !!agentSelectDisabled}
                className="w-full"
              />
              {agentSelectHelpText && (
                <p className="text-xs text-muted-foreground">
                  {agentSelectHelpText}
                </p>
              )}
            </div>

            {shouldShowReplyChannel && (
              <div className="space-y-2">
                <Label htmlFor="dialog-reply-channel">Reply in</Label>
                <Select
                  value={values.replyChannel}
                  onValueChange={(value) =>
                    onReplyChannelChange?.(value as ScheduleTriggerReplyChannel)
                  }
                >
                  <SelectTrigger id="dialog-reply-channel">
                    <SelectValue placeholder="Select channel">
                      <ReplyChannelLabel channel={values.replyChannel} />
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {channels.map((channel) => {
                      const { label, Icon } = getReplyChannelMeta(channel);
                      return (
                        <SelectItem
                          key={channel}
                          value={channel}
                          icon={
                            <Icon className="h-4 w-4 text-muted-foreground" />
                          }
                        >
                          {label}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="dialog-prompt">{promptLabel}</Label>
                {promptHeaderExtra}
              </div>
              {promptDescription ? (
                <div className="text-xs text-muted-foreground">
                  {promptDescription}
                </div>
              ) : null}
              {promptBody ?? (
                <Textarea
                  id="dialog-prompt"
                  value={values.messageTemplate}
                  onChange={(event) =>
                    onMessageTemplateChange(event.target.value)
                  }
                  disabled={promptLoading}
                  placeholder={
                    promptLoading
                      ? "Generating summary…"
                      : (promptPlaceholder ??
                        "Ask the agent to do something on every run.")
                  }
                  className="min-h-[80px] resize-y"
                />
              )}
            </div>

            <ScheduleSection
              cronExpression={values.cronExpression}
              onCronExpressionChange={onCronExpressionChange}
            />

            {showTimezone && onTimezoneChange && (
              <div className="space-y-2">
                <Label htmlFor="dialog-timezone">Timezone</Label>
                <Input
                  id="dialog-timezone"
                  value={values.timezone}
                  onChange={(event) => onTimezoneChange(event.target.value)}
                  placeholder="e.g. Europe/Berlin"
                />
              </div>
            )}

            {showEnabled && onEnabledChange && (
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <Label htmlFor="dialog-enabled">Enable immediately</Label>
                  <p className="text-xs text-muted-foreground">
                    If disabled, you can enable the task later from Scheduled
                    Tasks.
                  </p>
                </div>
                <Switch
                  id="dialog-enabled"
                  checked={values.enabled ?? true}
                  onCheckedChange={onEnabledChange}
                />
              </div>
            )}

            {postEnabledSection}

            <CronPreview
              cronExpression={values.cronExpression}
              timezone={values.timezone}
            />
          </DialogBody>

          <DialogStickyFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <PermissionButton
              permissions={permissions}
              type="submit"
              disabled={isSaving || !isFormValid}
            >
              {isSaving && (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              )}
              {submitLabel}
            </PermissionButton>
          </DialogStickyFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

type ScheduleMode = "hourly" | "daily";

const WEEKDAYS = [
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 },
  { label: "Sun", value: 0 },
] as const;

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: `${String(i).padStart(2, "0")}:00`,
}));

function ReplyChannelLabel({
  channel,
}: {
  channel: ScheduleTriggerReplyChannel;
}) {
  const { label, Icon } = getReplyChannelMeta(channel);
  return (
    <>
      <Icon className="h-4 w-4 text-muted-foreground" />
      {label}
    </>
  );
}

function getReplyChannelMeta(channel: ScheduleTriggerReplyChannel): {
  label: string;
  Icon: typeof MessageCircle;
} {
  switch (channel) {
    case "chat":
      return { label: "Chat", Icon: MessageCircle };
    case "slack_dm":
      return { label: "Slack DM", Icon: Slack };
    default: {
      const _exhaustive: never = channel;
      throw new Error(`Unexpected reply channel: ${String(_exhaustive)}`);
    }
  }
}

function parseCronToMode(cron: string): {
  mode: ScheduleMode;
  hour: string;
  minute: string;
  days: number[];
} {
  const parts = cron.trim().split(/\s+/);
  const defaults = {
    hour: "9",
    minute: "0",
    days: [1, 2, 3, 4, 5],
  };

  if (parts.length !== 5) {
    return { mode: "daily", ...defaults };
  }

  const [min, hr, , , dow] = parts;

  if (hr === "*" && dow === "*") {
    return {
      mode: "hourly",
      hour: defaults.hour,
      minute: min,
      days: defaults.days,
    };
  }

  if (hr !== "*" && !hr.includes("/")) {
    const dayList =
      dow === "*"
        ? [0, 1, 2, 3, 4, 5, 6]
        : dow.split(",").flatMap((part) => {
            if (part.includes("-")) {
              const [start, end] = part.split("-").map(Number);
              const result: number[] = [];
              for (let i = start; i <= end; i++) result.push(i);
              return result;
            }
            return [Number(part)];
          });

    return {
      mode: "daily",
      hour: hr,
      minute: min,
      days: dayList,
    };
  }

  return { mode: "daily", ...defaults };
}

function buildCronFromSchedule(
  mode: ScheduleMode,
  hour: string,
  minute: string,
  days: number[],
): string {
  switch (mode) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily": {
      const sorted = [...days].sort((a, b) => a - b);
      const dowPart =
        sorted.length === 7 || sorted.length === 0 ? "*" : sorted.join(",");
      return `${minute} ${hour} * * ${dowPart}`;
    }
  }
}

function ScheduleSection({
  cronExpression,
  onCronExpressionChange,
}: {
  cronExpression: string;
  onCronExpressionChange: (value: string) => void;
}) {
  const parsed = useMemo(
    () => parseCronToMode(cronExpression),
    [cronExpression],
  );
  const [mode, setMode] = useState<ScheduleMode>(parsed.mode);
  const [hour, setHour] = useState(parsed.hour);
  const [minute] = useState(parsed.minute);
  const [days, setDays] = useState<number[]>(parsed.days);

  useEffect(() => {
    const canonical = buildCronFromSchedule(
      parsed.mode,
      parsed.hour,
      parsed.minute,
      parsed.days,
    );
    if (canonical !== cronExpression.trim()) {
      onCronExpressionChange(canonical);
    }
  }, [parsed, cronExpression, onCronExpressionChange]);

  const updateCron = useCallback(
    (
      newMode: ScheduleMode,
      newHour: string,
      newMinute: string,
      newDays: number[],
    ) => {
      onCronExpressionChange(
        buildCronFromSchedule(newMode, newHour, newMinute, newDays),
      );
    },
    [onCronExpressionChange],
  );

  const handleModeChange = (newMode: ScheduleMode) => {
    setMode(newMode);
    updateCron(newMode, hour, minute, days);
  };

  const handleHourChange = (newHour: string) => {
    setHour(newHour);
    updateCron(mode, newHour, minute, days);
  };

  const handleDayToggle = (day: number) => {
    const newDays = days.includes(day)
      ? days.filter((d) => d !== day)
      : [...days, day];
    if (newDays.length === 0) return;
    setDays(newDays);
    updateCron(mode, hour, minute, newDays);
  };

  return (
    <div className="space-y-3">
      <Label>Schedule</Label>

      <div className="flex gap-1 rounded-md border p-1">
        {(["hourly", "daily"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => handleModeChange(m)}
            className={cn(
              "flex-1 rounded-sm px-2 py-1.5 text-xs font-medium capitalize transition-colors",
              mode === m
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === "daily" && (
        <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2">
          <Label className="self-end">Repeat on</Label>
          <Label className="self-end">Time</Label>
          <div className="flex gap-1">
            {WEEKDAYS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => handleDayToggle(d.value)}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-md border text-xs font-medium transition-colors",
                  days.includes(d.value)
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input text-muted-foreground hover:bg-muted",
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
          <Select value={hour} onValueChange={handleHourChange}>
            <SelectTrigger className="w-[90px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOURS.map((h) => (
                <SelectItem key={h.value} value={h.value}>
                  {h.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

function CronPreview({
  cronExpression,
  timezone,
}: {
  cronExpression: string;
  timezone: string;
}) {
  const hint = useMemo(() => {
    const trimmed = cronExpression.trim();
    if (!trimmed) return null;
    try {
      const cron = new Cron(trimmed, { timezone });
      const next = cron.nextRun();
      return next ? `Next run: ${next.toLocaleString()}` : "No upcoming run";
    } catch {
      return "Invalid schedule";
    }
  }, [cronExpression, timezone]);

  if (!hint) return null;
  const isInvalid = hint === "Invalid schedule";

  return (
    <p
      className={cn(
        "text-xs",
        isInvalid ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {hint}
    </p>
  );
}
