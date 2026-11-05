"use client";

import { ChevronDown, Info, Plus } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  type FieldValues,
  type UseFormReturn,
  useFieldArray,
} from "react-hook-form";
import { AccessModeCards } from "@/components/access-mode-cards";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  type GithubRepositoryEntryDraft,
  githubRepositoryDraftFingerprint,
  githubRepositoryEntriesDraft,
  githubRepositorySettingsDraft,
  githubRepositoryStandardSettingsDraft,
  joinIfArray,
} from "./transform-config-array-fields";

const BOOLEAN_SETTINGS = [
  {
    name: "includeIssues",
    label: "Include Issues",
    fallback: true,
    description: "Sync issues and their comments.",
  },
  {
    name: "includePullRequests",
    label: "Include Pull Requests",
    fallback: true,
    description: "Sync pull requests and their comments.",
  },
  {
    name: "includeRepositoryFiles",
    label: "Include Repository Files",
    fallback: false,
    description: "Sync selected text files from repositories.",
  },
] as const;
const LIST_SETTINGS = [
  {
    name: "labelsToSkip",
    label: "Labels to Skip (optional)",
    placeholder: "wontfix, duplicate",
    description: "Comma-separated list of labels to exclude.",
  },
  {
    name: "fileTypes",
    label: "File Types (optional)",
    placeholder: ".md, .yaml, Dockerfile",
    description:
      "Comma-separated extensions or file names to index when repository files are enabled, such as .md or Dockerfile. Use * for every text file. Defaults to Markdown and YAML.",
  },
  {
    name: "includePaths",
    label: "Folders (optional)",
    placeholder: "docs, packages/api/src",
    description:
      "Comma-separated folders to index, relative to the repository root. Leave blank to index the whole repository.",
  },
  {
    name: "excludePaths",
    label: "Exclude paths",
    placeholder: "docs/internal, generated",
    description:
      "Comma-separated files or folders to skip. Exclusions win. Blank excludes nothing.",
  },
] as const;

type Props = { form: UseFormReturn<FieldValues>; prefix: string };

function Disclosure({
  title,
  open,
  onOpenChange,
  actions,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="rounded-md border"
    >
      <div className="flex items-center gap-2 pr-3">
        <CollapsibleTrigger asChild>
          <UnstyledButton
            className="group flex min-w-0 flex-1 items-center gap-3 rounded-md px-4 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label={`Repository settings for ${title}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-medium">
                {title}
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
            />
          </UnstyledButton>
        </CollapsibleTrigger>
        {actions}
      </div>
      {/* Unmounted controllers skip validation, including invalid repository names. */}
      <CollapsibleContent
        forceMount
        hidden={!open}
        className="space-y-4 border-t px-4 py-4"
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function GithubRepositorySettings({ form, prefix }: Props) {
  const config = form.watch(prefix) as Record<string, unknown>;
  const entryPath = `${prefix}.repositoryEntries`;
  const entries = form.watch(entryPath) as
    | GithubRepositoryEntryDraft[]
    | undefined;
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: entryPath,
  });
  const mode =
    form.watch(`${prefix}.repositorySelectionMode`) ??
    ((Array.isArray(config.repos) && config.repos.length > 0) ||
    (typeof config.repos === "string" && config.repos.trim())
      ? "selected"
      : "all");
  const sharedPath = `${prefix}.repositorySharedSettings`;
  const sharedSettings = form.watch(sharedPath) as
    | Record<string, unknown>
    | undefined;
  const applyShared = form.watch(`${prefix}.repositoryApplyShared`) === true;
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    if (entries !== undefined) return;
    const rows = githubRepositoryEntriesDraft(config);
    if (config.repositoryOverrides === undefined)
      form.setValue(
        `${prefix}.repositoryLegacyBaseline`,
        {
          owner: config.owner,
          fingerprint: githubRepositoryDraftFingerprint(rows),
        },
        { shouldDirty: false },
      );
    form.setValue(entryPath, rows, { shouldDirty: false });
  }, [config, entries, entryPath, form, prefix]);
  useEffect(() => {
    if (sharedSettings === undefined)
      form.setValue(sharedPath, githubRepositorySettingsDraft(config), {
        shouldDirty: false,
      });
  }, [config, form, sharedPath, sharedSettings]);

  const validateName = (value: string, index: number) => {
    if (mode === "all") return true;
    if (!value.trim()) return "Repository is required";
    if (!/^[^/\\\s,]+\/[^/\\\s,]+$/.test(value.trim())) return "Use owner/repo";
    return (
      (entries ?? []).every(
        (entry, other) =>
          other === index ||
          entry.repository.trim().toLowerCase() !== value.trim().toLowerCase(),
      ) || "Each repository can be selected only once"
    );
  };
  return (
    <div className="space-y-4">
      <AccessModeCards
        label="Repository selection"
        mode={mode === "all" ? "all" : "manual"}
        all={{
          title: "All accessible repositories",
          rule: "Use the same settings for every accessible repository, including new repositories.",
        }}
        manual={{
          title: "Selected repositories",
          rule: "Only sync the repositories you add, each with its own settings.",
        }}
        onModeChange={(next) => {
          const mode = next === "all" ? "all" : "selected";
          form.setValue(`${prefix}.repositorySelectionMode`, mode, {
            shouldDirty: true,
          });
          if (mode === "all") {
            form.setValue(`${prefix}.repositoryApplyShared`, true, {
              shouldDirty: true,
            });
            form.clearErrors([`${prefix}.repos`, entryPath]);
          }
        }}
      />
      <FormField
        control={form.control}
        name={`${prefix}.repos`}
        rules={{
          validate: () =>
            mode === "all" ||
            (entries?.length ?? 0) > 0 ||
            "Add at least one repository or choose All accessible repositories.",
        }}
        render={() => (
          <FormItem>
            <FormMessage />
          </FormItem>
        )}
      />
      {mode === "all" ? (
        <>
          {Array.isArray(config.repositoryOverrides) &&
            config.repositoryOverrides.length > 0 &&
            !applyShared && (
              <InlineNotice variant="neutral">
                <Info />
                <InlineNoticeText>
                  Existing repository-specific settings are preserved. Changing
                  these shared settings applies them to every repository.
                </InlineNoticeText>
              </InlineNotice>
            )}
          <RepositoryControls
            form={form}
            prefix={sharedPath}
            values={sharedSettings ?? githubRepositorySettingsDraft(config)}
            onChange={() =>
              form.setValue(`${prefix}.repositoryApplyShared`, true, {
                shouldDirty: true,
              })
            }
          />
        </>
      ) : (
        <div className="space-y-2">
          {fields.map((field, index) => {
            const entry = entries?.[index];
            if (!entry) return null;
            const name = entry.repository.trim() || "New repository";
            const path = `${entryPath}.${index}.repository`;
            const invalid = Boolean(
              form.getFieldState(path, form.formState).error,
            );
            return (
              <fieldset key={field.id} aria-label={`Repository ${name}`}>
                <Disclosure
                  title={name}
                  open={
                    openKey === field.id ||
                    invalid ||
                    (openKey === "new-entry" &&
                      index === (entries?.length ?? 0) - 1)
                  }
                  onOpenChange={(open) => setOpenKey(open ? field.id : null)}
                  actions={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove repository ${name}`}
                      onClick={() => {
                        remove(index);
                        setOpenKey(null);
                      }}
                    >
                      Remove
                    </Button>
                  }
                >
                  <FormField
                    control={form.control}
                    name={path}
                    rules={{
                      validate: (value: string) => validateName(value, index),
                    }}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Repository</FormLabel>
                        <FormDescription>
                          Enter owner/repo. Renaming keeps this entry's
                          settings.
                        </FormDescription>
                        <FormControl>
                          <Input placeholder="owner/repo" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <RepositoryControls
                    form={form}
                    prefix={`${entryPath}.${index}.settings`}
                    values={entry.settings}
                    disabled={validateName(entry.repository, index) !== true}
                  />
                </Disclosure>
              </fieldset>
            );
          })}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              append({
                repository: "",
                settings: githubRepositoryStandardSettingsDraft(),
              });
              setOpenKey("new-entry");
            }}
          >
            <Plus />
            <span>Add repository</span>
          </Button>
        </div>
      )}
    </div>
  );
}

function RepositoryControls({
  form,
  prefix,
  values,
  onChange,
  disabled = false,
}: Props & {
  values: Record<string, unknown>;
  onChange?: (name: string, value: unknown) => void;
  disabled?: boolean;
}) {
  return (
    <>
      {BOOLEAN_SETTINGS.map((setting) => (
        <FormField
          key={setting.name}
          control={form.control}
          name={`${prefix}.${setting.name}`}
          render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <FormLabel>{setting.label}</FormLabel>
                <FormDescription>{setting.description}</FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={Boolean(values[setting.name])}
                  disabled={disabled}
                  onCheckedChange={(value) => {
                    field.onChange(value);
                    onChange?.(setting.name, value);
                  }}
                />
              </FormControl>
            </FormItem>
          )}
        />
      ))}
      {LIST_SETTINGS.filter(
        (setting) =>
          setting.name === "labelsToSkip" || values.includeRepositoryFiles,
      ).map((setting) => (
        <FormField
          key={setting.name}
          control={form.control}
          name={`${prefix}.${setting.name}`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{setting.label}</FormLabel>
              <FormDescription>{setting.description}</FormDescription>
              <FormControl>
                <Input
                  placeholder={setting.placeholder}
                  {...field}
                  value={joinIfArray(values[setting.name])}
                  disabled={disabled}
                  onChange={(event) => {
                    field.onChange(event.target.value);
                    onChange?.(setting.name, event.target.value);
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      ))}
    </>
  );
}
