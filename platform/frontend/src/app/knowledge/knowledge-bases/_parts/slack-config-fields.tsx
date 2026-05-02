"use client";

import type { Control } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

// biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
export function SlackConfigFields({ control }: { control: Control<any> }) {
  return (
    <div className="space-y-4">
      <FormField
        control={control}
        name="config.channelIds"
        rules={{
          validate: (value) => {
            const raw = (value ?? "") as string;
            const ids = raw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            return ids.length > 0 || "Channel IDs are required";
          },
        }}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Channel IDs (required)</FormLabel>
            <FormControl>
              <Input
                placeholder="C07XXXXXX, G08YYYYYY"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated Slack channel IDs to sync. Find channel IDs in
              Slack: right-click a channel → View channel details → scroll to
              the bottom.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name="config.skipBotMessages"
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Skip Bot Messages</FormLabel>
              <FormDescription>
                Exclude messages from bots and integrations.
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={(field.value as boolean) ?? true}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name="config.syncWindowDays"
        rules={{
          validate: (value) => {
            if (value === undefined || value === null || value === "") {
              return true;
            }

            const parsedValue =
              typeof value === "number"
                ? value
                : Number.parseFloat(String(value));
            if (!Number.isFinite(parsedValue)) {
              return "Sync window must be a whole number between 1 and 3650";
            }

            if (!Number.isInteger(parsedValue)) {
              return "Sync window must be a whole number between 1 and 3650";
            }

            if (parsedValue < 1 || parsedValue > 3650) {
              return "Sync window must be a whole number between 1 and 3650";
            }

            return true;
          },
        }}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Sync Window (days)</FormLabel>
            <FormControl>
              <Input
                type="number"
                min={1}
                max={3650}
                step={1}
                placeholder="90"
                {...field}
                onChange={(e) => {
                  const raw = e.target.value;
                  field.onChange(raw === "" ? undefined : Number(raw));
                }}
                value={(field.value as number | string | undefined) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Optional. Limits indexing to messages from the last N days per
              selected channel.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
