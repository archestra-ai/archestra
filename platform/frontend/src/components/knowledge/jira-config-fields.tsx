"use client";

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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

interface JiraConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
  hideUrl?: boolean;
  hideIsCloud?: boolean;
}

export function JiraConfigFields({
  form,
  prefix = "config",
  hideUrl = false,
  hideIsCloud = false,
}: JiraConfigFieldsProps) {
  return (
    <div className="space-y-4">
      {!hideUrl && (
        <FormField
          control={form.control}
          name={`${prefix}.jiraBaseUrl`}
          rules={{ required: "Base URL is required" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Base URL</FormLabel>
              <FormDescription>Your Jira instance URL.</FormDescription>
              <FormControl>
                <Input
                  placeholder="https://your-domain.atlassian.net"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      {!hideIsCloud && (
        <FormField
          control={form.control}
          name={`${prefix}.isCloud`}
          render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <FormLabel>Cloud Instance</FormLabel>
                <FormDescription>
                  Enable if this is a Jira Cloud instance.
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value ?? true}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      )}

      <FormField
        control={form.control}
        name={`${prefix}.projectKey`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Project Keys (optional)</FormLabel>
            <FormDescription>
              Comma-separated project keys to include.
            </FormDescription>
            <FormControl>
              <Input placeholder="ENG, OPS" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.jqlQuery`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>JQL Query (optional)</FormLabel>
            <FormDescription>Custom JQL to filter issues.</FormDescription>
            <FormControl>
              <Textarea
                placeholder='project = PROJ AND status = "Done"'
                rows={3}
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.commentEmailBlacklist`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Comment Email Blacklist (optional)</FormLabel>
            <FormDescription>
              Comma-separated list of email addresses whose comments should be
              excluded.
            </FormDescription>
            <FormControl>
              <Input
                placeholder="bot@example.com, noreply@example.com"
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.labelsToSkip`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Labels to Skip (optional)</FormLabel>
            <FormDescription>
              Comma-separated list of labels to exclude.
            </FormDescription>
            <FormControl>
              <Input placeholder="internal, draft" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
