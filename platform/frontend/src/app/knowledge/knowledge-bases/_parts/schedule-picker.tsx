"use client";

import type { UseFormReturn } from "react-hook-form";
import {
  CronExpressionPicker,
  DEFAULT_CRON_PRESET_OPTIONS,
} from "@/components/ui/cron-expression-picker";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

interface SchedulePickerProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  name: string;
}

export function SchedulePicker({ form, name }: SchedulePickerProps) {
  return (
    <FormField
      control={form.control}
      name={name}
      rules={{ required: "Schedule is required" }}
      render={({ field }) => (
        <FormItem>
          <FormLabel>Schedule</FormLabel>
          <FormControl>
            <div className="space-y-2">
              <CronExpressionPicker
                value={field.value ?? ""}
                onChange={field.onChange}
                presets={DEFAULT_CRON_PRESET_OPTIONS}
                descriptionFallback="Cron expression for sync schedule."
              />
            </div>
          </FormControl>
          <FormDescription>
            Pick a preset or switch to a custom 5-field cron expression.
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
