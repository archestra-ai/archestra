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

interface GithubConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
  hideUrl?: boolean;
  hideOwner?: boolean;
}

export function GithubConfigFields({
  form,
  prefix = "config",
  hideUrl = false,
  hideOwner = false,
}: GithubConfigFieldsProps) {
  return (
    <div className="space-y-4">
      {!hideUrl && (
        <FormField
          control={form.control}
          name={`${prefix}.githubUrl`}
          rules={{ required: "GitHub URL is required" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>GitHub API URL</FormLabel>
              <FormControl>
                <Input placeholder="https://api.github.com" {...field} />
              </FormControl>
              <FormDescription>
                Use https://api.github.com for GitHub.com, or
                https://github.example.com/api/v3 for GitHub Enterprise.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      {!hideOwner && (
        <FormField
          control={form.control}
          name={`${prefix}.owner`}
          rules={{ required: "Owner is required" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Owner</FormLabel>
              <FormControl>
                <Input placeholder="my-org" {...field} />
              </FormControl>
              <FormDescription>
                GitHub organization or username that owns the repositories.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <FormField
        control={form.control}
        name={`${prefix}.repos`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Repositories (optional)</FormLabel>
            <FormControl>
              <Input placeholder="repo-a, repo-b" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated list of repository names. Leave blank to sync all
              repositories.
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
        name={`${prefix}.includePullRequests`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Pull Requests</FormLabel>
              <FormDescription>
                Sync pull requests and their comments.
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
        name={`${prefix}.includeMarkdownFiles`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Markdown Files</FormLabel>
              <FormDescription>
                Sync .md and .mdx files from repositories.
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value ?? false}
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
