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

interface GitlabConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
  hideUrl?: boolean;
}

export function GitlabConfigFields({
  form,
  prefix = "config",
  hideUrl = false,
}: GitlabConfigFieldsProps) {
  return (
    <div className="space-y-4">
      {!hideUrl && (
        <FormField
          control={form.control}
          name={`${prefix}.gitlabUrl`}
          rules={{ required: "GitLab URL is required" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>GitLab URL</FormLabel>
              <FormControl>
                <Input placeholder="https://gitlab.com" {...field} />
              </FormControl>
              <FormDescription>
                Use https://gitlab.com or your self-hosted GitLab URL.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <FormField
        control={form.control}
        name={`${prefix}.groupId`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Group Path (optional)</FormLabel>
            <FormControl>
              <Input placeholder="my-org/my-subgroup" {...field} />
            </FormControl>
            <FormDescription>
              The path of the GitLab group to sync from. Found in the group URL
              (e.g. gitlab.com/groups/my-org/my-subgroup). Leave blank to sync
              all accessible projects.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.projectIds`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Project IDs (optional)</FormLabel>
            <FormControl>
              <Input placeholder="123, 456" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated list of specific project IDs to sync.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.includeIssues`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Issues</FormLabel>
              <FormDescription>Sync issues and their comments.</FormDescription>
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

      <FormField
        control={form.control}
        name={`${prefix}.includeMergeRequests`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Merge Requests</FormLabel>
              <FormDescription>
                Sync merge requests and their comments.
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

      <FormField
        control={form.control}
        name={`${prefix}.labelsToSkip`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Labels to Skip (optional)</FormLabel>
            <FormControl>
              <Input placeholder="wontfix, duplicate" {...field} />
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
