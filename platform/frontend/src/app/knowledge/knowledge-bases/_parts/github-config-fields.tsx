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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

interface GithubConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
  hideUrl?: boolean;
  hideOwner?: boolean;
  hideAuth?: boolean;
  hideRepositoryOptions?: boolean;
}

export function GithubConfigFields({
  form,
  prefix = "config",
  hideUrl = false,
  hideOwner = false,
  hideAuth = false,
  hideRepositoryOptions = false,
}: GithubConfigFieldsProps) {
  const authMethod = form.watch(`${prefix}.authMethod`) as string | undefined;
  const includeRepositoryFiles = form.watch(
    `${prefix}.includeRepositoryFiles`,
  ) as boolean | undefined;
  const usesGithubApp = authMethod === "github_app";

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

      {!hideAuth && (
        <>
          <FormField
            control={form.control}
            name={`${prefix}.authMethod`}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Authentication Method</FormLabel>
                <Select
                  onValueChange={field.onChange}
                  value={(field.value as string | undefined) ?? "pat"}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="pat">Personal Access Token</SelectItem>
                    <SelectItem value="github_app">GitHub App</SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription>
                  Use GitHub App authentication for organization-managed
                  installs.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {usesGithubApp && (
            <>
              <FormField
                control={form.control}
                name={`${prefix}.githubAppId`}
                rules={{ required: "GitHub App ID is required" }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>GitHub App ID</FormLabel>
                    <FormControl>
                      <Input placeholder="123456" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name={`${prefix}.githubAppInstallationId`}
                rules={{ required: "Installation ID is required" }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Installation ID</FormLabel>
                    <FormControl>
                      <Input placeholder="98765432" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          )}
        </>
      )}

      {!hideRepositoryOptions && (
        <>
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
                  Comma-separated list of repository names. Leave blank to sync
                  all repositories.
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
                  <FormDescription>
                    Sync issues and their comments.
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
            name={`${prefix}.includeRepositoryFiles`}
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <FormLabel>Include Repository Files</FormLabel>
                  <FormDescription>
                    Sync selected text files from repositories.
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
        </>
      )}

      {!hideRepositoryOptions && includeRepositoryFiles === true && (
        <FormField
          control={form.control}
          name={`${prefix}.fileTypes`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>File Types (optional)</FormLabel>
              <FormControl>
                <Input placeholder=".md, .mdx, .yaml, .yml" {...field} />
              </FormControl>
              <FormDescription>
                Comma-separated extensions to index when repository files are
                enabled. Defaults to Markdown and YAML.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
    </div>
  );
}
