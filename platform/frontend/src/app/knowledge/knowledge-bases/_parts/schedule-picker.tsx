"use client";

import { useMemo, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCronSchedule } from "@/lib/utils/format-cron";

const PRESET_SCHEDULES = [
  { label: "Every 30 minutes", value: "*/30 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Every 12 hours", value: "0 */12 * * *" },
  { label: "Daily", value: "0 0 * * *" },
  { label: "Weekly", value: "0 0 * * 0" },
  { label: "Custom", value: "custom" },
] as const;

interface SchedulePickerProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  name: string;
}

export function SchedulePicker({ form, name }: SchedulePickerProps) {
  const currentValue = form.watch(name) as string;
  const isPreset = PRESET_SCHEDULES.some(
    (p) => p.value !== "custom" && p.value === currentValue,
  );
  const [isCustom, setIsCustom] = useState(!isPreset && !!currentValue);

  const humanReadable = useMemo(() => {
    if (!currentValue) return null;
    const result = formatCronSchedule(currentValue);
    return result !== currentValue ? result : null;
  }, [currentValue]);

  return (
    <FormField
      control={form.control}
      name={name}
      rules={{ required: "Schedule is required" }}
      render={({ field }) => (
        <FormItem>
          <FormLabel>Schedule</FormLabel>
          <div className="space-y-2">
            <Select
              value={isCustom ? "custom" : field.value}
              onValueChange={(value) => {
                if (value === "custom") {
                  setIsCustom(true);
                } else {
                  setIsCustom(false);
                  field.onChange(value);
                }
              }}
            >
              <FormControl>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a schedule" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {PRESET_SCHEDULES.map((schedule) => (
                  <SelectItem key={schedule.value} value={schedule.value}>
                    {schedule.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isCustom && (
              <Input
                placeholder="0 */6 * * *"
                value={field.value}
                onChange={field.onChange}
              />
            )}
            <FormDescription>
              {humanReadable ?? "Cron expression for sync schedule."}
            </FormDescription>
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
