"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useId } from "react";
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
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";

interface GithubConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
  hideUrl?: boolean;
  hideOwner?: boolean;
  hideAuth?: boolean;
  hideRepositoryOptions?: boolean;
  /**
   * Extra line under the GitHub App configuration picker. App credentials are
   * stored organization-wide instead of on this form, so requirements about
   * what the App must be granted have no token field to sit under.
   */
  appConfigDescription?: ReactNode;
}

export function GithubConfigFields({
  form,
  prefix = "config",
  hideUrl = false,
  hideOwner = false,
  hideAuth = false,
  hideRepositoryOptions = false,
  appConfigDescription,
}: GithubConfigFieldsProps) {
  const credentialSelectId = useId();
  const githubAppConfigId = form.watch(`${prefix}.githubAppConfigId`) as
    | string
    | undefined;
  const includeRepositoryFiles = form.watch(
    `${prefix}.includeRepositoryFiles`,
  ) as boolean | undefined;
  const { data: credentials = [] } = useRuntimeCredentials();
  const credentialId = form.watch(`${prefix}.credentialId`) as
    | string
    | undefined;
  const githubCredentials = credentials.filter(
    (credential) =>
      credential.allowOrganization &&
      ["github_app", "secret"].includes(credential.kind),
  );
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
              <FormDescription>
                Use https://api.github.com for GitHub.com, or
                https://github.example.com/api/v3 for GitHub Enterprise.
              </FormDescription>
              <FormControl>
                <Input placeholder="https://api.github.com" {...field} />
              </FormControl>
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
              <FormDescription>
                GitHub organization or username that owns the repositories.
              </FormDescription>
              <FormControl>
                <Input placeholder="my-org" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      {!hideAuth && (
        <FormItem>
          <FormLabel htmlFor={credentialSelectId}>Credential</FormLabel>
          <Select
            value={
              credentialId ??
              githubCredentials.find(
                (credential) => credential.id === githubAppConfigId,
              )?.key ??
              "inline"
            }
            onValueChange={(value) => {
              form.setValue(
                `${prefix}.credentialId`,
                value === "inline" ? undefined : value,
                { shouldDirty: true, shouldValidate: true },
              );
              form.setValue(
                `${prefix}.authMethod`,
                value === "inline" ? "pat" : "credential",
                { shouldDirty: true, shouldValidate: true },
              );
              form.setValue(`${prefix}.githubAppConfigId`, undefined, {
                shouldDirty: true,
                shouldValidate: true,
              });
            }}
          >
            <SelectTrigger id={credentialSelectId} className="w-full">
              <SelectValue placeholder="Select a credential" />
            </SelectTrigger>
            <SelectContent>
              {githubCredentials.map((credential) => (
                <SelectItem
                  key={credential.key}
                  value={credential.key}
                  description="Organization credential"
                >
                  {credential.name}
                </SelectItem>
              ))}
              <SelectItem value="inline">
                Enter a token for this connector
              </SelectItem>
            </SelectContent>
          </Select>
          <FormDescription>
            Organization credentials support scheduled syncs.{" "}
            <Link href="/settings/credentials" className="underline">
              Manage credentials
            </Link>
            . {appConfigDescription}
          </FormDescription>
          {appConfigError && (
            <p className="text-sm text-destructive">{appConfigError}</p>
          )}
        </FormItem>
      )}

      {!hideRepositoryOptions && (
        <>
          <FormField
            control={form.control}
            name={`${prefix}.repos`}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Repositories (optional)</FormLabel>
                <FormDescription>
                  Comma-separated list of repository names. Leave blank to sync
                  all repositories.
                </FormDescription>
                <FormControl>
                  <Input placeholder="repo-a, repo-b" {...field} />
                </FormControl>
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
                <FormDescription>
                  Comma-separated list of labels to exclude.
                </FormDescription>
                <FormControl>
                  <Input placeholder="wontfix, duplicate" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      )}

      {!hideRepositoryOptions && includeRepositoryFiles === true && (
        <>
          <FormField
            control={form.control}
            name={`${prefix}.fileTypes`}
            render={({ field }) => (
              <FormItem>
                <FormLabel>File Types (optional)</FormLabel>
                <FormDescription>
                  Comma-separated extensions to index when repository files are
                  enabled. Defaults to Markdown and YAML.
                </FormDescription>
                <FormControl>
                  <Input placeholder=".md, .mdx, .yaml, .yml" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name={`${prefix}.includePaths`}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Folders (optional)</FormLabel>
                <FormDescription>
                  Comma-separated folders to index, relative to the repository
                  root. Applies to every selected repository. Leave blank to
                  index the whole repository.
                </FormDescription>
                <FormControl>
                  <Input placeholder="docs, packages/api/src" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
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
