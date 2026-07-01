"use client";

import { useEffect } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  GithubAuthConfigFields,
  type GithubAuthMethod,
} from "@/components/github-auth-config-fields";
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
import { useGithubAppConfigs } from "@/lib/github-app-config.query";

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
  const githubAppConfigId = form.watch(`${prefix}.githubAppConfigId`) as
    | string
    | undefined;
  const includeRepositoryFiles = form.watch(
    `${prefix}.includeRepositoryFiles`,
  ) as boolean | undefined;
  const { data: githubAppConfigs = [] } = useGithubAppConfigs();
  const appConfigError = hideAuth
    ? undefined
    : getFieldError(form.formState.errors, `${prefix}.githubAppConfigId`);

  useEffect(() => {
    if (hideAuth) return;
    form.register(`${prefix}.authMethod`);
    form.register(`${prefix}.githubAppConfigId`, {
      validate: (value) =>
        form.getValues(`${prefix}.authMethod`) !== "github_app" ||
        Boolean(value) ||
        "Select a GitHub App configuration",
    });
  }, [form, hideAuth, prefix]);

  const handleAuthMethodChange = (value: GithubAuthMethod) => {
    form.setValue(`${prefix}.authMethod`, value, {
      shouldDirty: true,
      shouldValidate: true,
    });
    if (value === "pat") {
      form.setValue(`${prefix}.githubAppConfigId`, "", {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  };

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
        <GithubAuthConfigFields
          authMethod={(authMethod as GithubAuthMethod | undefined) ?? "pat"}
          onAuthMethodChange={handleAuthMethodChange}
          githubAppConfigId={githubAppConfigId ?? ""}
          onGithubAppConfigIdChange={(value) =>
            form.setValue(`${prefix}.githubAppConfigId`, value, {
              shouldDirty: true,
              shouldValidate: true,
            })
          }
          githubAppConfigs={githubAppConfigs}
          appConfigError={appConfigError}
        />
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

function getFieldError(
  errors: Record<string, unknown> | undefined,
  path: string,
): string | undefined {
  const error = path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, errors);

  if (!error || typeof error !== "object" || !("message" in error)) {
    return undefined;
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}
