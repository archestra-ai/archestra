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
              <FormControl>
                <Input
                  placeholder="https://your-domain.atlassian.net"
                  {...field}
                />
              </FormControl>
              <FormDescription>Your Jira instance URL.</FormDescription>
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
            <FormLabel>Project Key (optional)</FormLabel>
            <FormControl>
              <Input placeholder="PROJ" {...field} />
            </FormControl>
            <FormDescription>Filter issues by project key.</FormDescription>
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
            <FormControl>
              <Textarea
                placeholder='project = PROJ AND status = "Done"'
                rows={3}
                {...field}
              />
            </FormControl>
            <FormDescription>Custom JQL to filter issues.</FormDescription>
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
            <FormControl>
              <Input
                placeholder="bot@example.com, noreply@example.com"
                {...field}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of email addresses whose comments should be
              excluded.
            </FormDescription>
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
            <FormControl>
              <Input placeholder="internal, draft" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated list of labels to exclude.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
