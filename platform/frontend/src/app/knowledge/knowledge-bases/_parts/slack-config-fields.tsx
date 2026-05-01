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
        name="config.includeThreadReplies"
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Thread Replies</FormLabel>
              <FormDescription>
                Collapse thread replies into the parent message for richer
                context.
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
    </div>
  );
}
