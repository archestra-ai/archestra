"use client";

import { ChevronDown, Info, Plus } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  type FieldValues,
  type UseFormReturn,
  useFieldArray,
} from "react-hook-form";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  githubRepositoryOverrideDraft,
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

type BooleanSetting = (typeof BOOLEAN_SETTINGS)[number];
type ListSetting = (typeof LIST_SETTINGS)[number];
type RepositoryOverrideDraft = { repository: string } & Partial<
  Record<BooleanSetting["name"], boolean | null> &
    Record<ListSetting["name"], string | string[] | null>
>;

type Props = { form: UseFormReturn<FieldValues>; prefix: string };

function repositories(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return entries.map((entry: string) => entry.trim()).filter(Boolean);
}

function findOverride(
  overrides: RepositoryOverrideDraft[],
  repository: string,
  owner: string,
) {
  const fullName = repository.includes("/")
    ? repository
    : `${owner}/${repository}`;
  const exact = overrides.findIndex(
    (entry) => entry.repository.trim().toLowerCase() === fullName.toLowerCase(),
  );
  if (exact >= 0) return exact;
  const [repoOwner, name] = fullName.split("/");
  return repoOwner.toLowerCase() === owner.toLowerCase()
    ? overrides.findIndex(
        (entry) => entry.repository.trim().toLowerCase() === name.toLowerCase(),
      )
    : -1;
}

function defaultValue(values: FieldValues | undefined, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined,
      values,
    );
}

function Disclosure({
  title,
  summary,
  open,
  onOpenChange,
  actions,
  children,
}: {
  title: string;
  summary: string;
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
              <span className="block text-xs text-muted-foreground">
                {summary}
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

type RepositoryEntryDraft = {
  repository: string;
  overrideIndex: number;
  ownsOverride: boolean;
  sourceRepository: string;
};

export function GithubRepositorySettings({ form, prefix }: Props) {
  const selectionId = useId();
  const canonical = form.watch(`${prefix}.repositoryOverrides`) as
    | RepositoryOverrideDraft[]
    | undefined;
  const legacy = form.watch(`${prefix}.repositoryPathFilters`) as
    | RepositoryOverrideDraft[]
    | undefined;
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: `${prefix}.repositoryOverrides`,
  });
  const entryPath = `${prefix}.repositoryEntries`;
  const entries = form.watch(entryPath) as RepositoryEntryDraft[] | undefined;
  const {
    fields: entryFields,
    append: appendEntry,
    remove: removeEntry,
  } = useFieldArray({ control: form.control, name: entryPath });
  const overrides = canonical ?? legacy ?? [];
  const owner = (form.watch(`${prefix}.owner`) as string | undefined) ?? "";
  const initialRepos = defaultValue(
    form.formState.defaultValues,
    `${prefix}.repos`,
  );
  const [mode, setMode] = useState<"selected" | "all">(() =>
    repositories(form.getValues(`${prefix}.repos`)).length ? "selected" : "all",
  );
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    setMode(repositories(initialRepos).length ? "selected" : "all");
  }, [initialRepos]);
  useEffect(() => {
    if (canonical === undefined)
      form.setValue(`${prefix}.repositoryOverrides`, legacy ?? [], {
        shouldDirty: false,
      });
  }, [canonical, form, legacy, prefix]);
  useEffect(() => {
    if (entries === undefined)
      form.setValue(
        entryPath,
        repositories(form.getValues(`${prefix}.repos`)).map((repository) => ({
          repository,
          overrideIndex: findOverride(overrides, repository, owner),
          ownsOverride: findOverride(overrides, repository, owner) >= 0,
          sourceRepository: repository,
        })),
        { shouldDirty: false },
      );
  }, [entries, entryPath, form, overrides, owner, prefix]);
  const previousOwner = useRef(owner);
  useEffect(() => {
    if (previousOwner.current === owner) return;
    previousOwner.current = owner;
    // Owner scopes bare names; changing it must not rename a qualified rule.
    for (const [index, entry] of (entries ?? []).entries()) {
      const overrideIndex = findOverride(overrides, entry.repository, owner);
      form.setValue(`${entryPath}.${index}.overrideIndex`, overrideIndex);
      form.setValue(`${entryPath}.${index}.ownsOverride`, overrideIndex >= 0);
      form.setValue(`${entryPath}.${index}.sourceRepository`, entry.repository);
    }
  }, [entries, entryPath, form, overrides, owner]);
  const defaults = form.watch(prefix) as Record<string, unknown>;
  const activeIndices = new Set(
    (entries ?? [])
      .map((entry) => entry.overrideIndex)
      .filter((index) => index >= 0),
  );
  const otherOverrides = fields
    .map((field, index) => ({ field, index }))
    .filter(({ index }) => mode === "all" || !activeIndices.has(index));
  const identity = (repository: string) => {
    const name = repository.trim().toLowerCase();
    return name.includes("/") ? name : `${owner.toLowerCase()}/${name}`;
  };
  const summary = (override?: RepositoryOverrideDraft) =>
    BOOLEAN_SETTINGS.map(
      ({ name, label, fallback }) =>
        `${label.replace("Include ", "")}: ${(override?.[name] ?? defaults[name] ?? fallback) ? "on" : "off"}`,
    ).join(" · ");
  const removeSavedSettings = (index: number, includeAliases = false) => {
    const repository = overrides[index].repository;
    const indices =
      includeAliases && repository.trim()
        ? overrides.flatMap((entry, entryIndex) =>
            identity(entry.repository) === identity(repository)
              ? [entryIndex]
              : [],
          )
        : [index];
    remove(indices);
    for (const [entryIndex, entry] of (entries ?? []).entries()) {
      const nextIndex = indices.includes(entry.overrideIndex)
        ? -1
        : entry.overrideIndex -
          indices.filter((removed) => removed < entry.overrideIndex).length;
      form.setValue(`${entryPath}.${entryIndex}.overrideIndex`, nextIndex, {
        shouldDirty: true,
      });
      if (nextIndex < 0) {
        form.setValue(`${entryPath}.${entryIndex}.ownsOverride`, false);
        form.setValue(
          `${entryPath}.${entryIndex}.sourceRepository`,
          entry.repository,
        );
      }
    }
  };
  const validateName = (value: string, entryIndex: number) => {
    if (mode === "all") return true;
    if (!value.trim()) return "Repository is required";
    if (!/^[^/\\\s,]+(?:\/[^/\\\s,]+)?$/.test(value.trim()))
      return "Use a repository name or owner/repo";
    const current = form.getValues(entryPath) as RepositoryEntryDraft[];
    if (
      !current.every(
        (entry, index) =>
          index === entryIndex ||
          identity(entry.repository) !== identity(value),
      )
    )
      return "Each repository can be selected only once";
    const entry = current[entryIndex];
    if (
      entry.ownsOverride &&
      identity(value) !== identity(entry.sourceRepository) &&
      overrides.some(
        (override, index) =>
          index !== entry.overrideIndex &&
          identity(override.repository) === identity(value),
      )
    )
      return "This repository already has saved settings. Remove them before renaming this entry.";
    return true;
  };
  const applyName = (value: string, entryIndex: number) => {
    const entry = form.getValues(
      `${entryPath}.${entryIndex}`,
    ) as RepositoryEntryDraft;
    if (validateName(value, entryIndex) !== true) {
      if (!entry.ownsOverride)
        form.setValue(`${entryPath}.${entryIndex}.overrideIndex`, -1);
      return;
    }
    if (
      entry.ownsOverride &&
      entry.overrideIndex >= 0 &&
      overrides[entry.overrideIndex]
    ) {
      const shared = (form.getValues(entryPath) as RepositoryEntryDraft[]).some(
        (other, index) =>
          index !== entryIndex && other.overrideIndex === entry.overrideIndex,
      );
      if (shared && identity(value) !== identity(entry.sourceRepository)) {
        const nextIndex = overrides.length;
        append(
          githubRepositoryOverrideDraft({
            ...overrides[entry.overrideIndex],
            repository: value,
          }),
        );
        form.setValue(`${entryPath}.${entryIndex}.overrideIndex`, nextIndex, {
          shouldDirty: true,
        });
      } else
        form.setValue(
          `${prefix}.repositoryOverrides.${entry.overrideIndex}.repository`,
          value,
          { shouldDirty: true },
        );
    } else
      form.setValue(
        `${entryPath}.${entryIndex}.overrideIndex`,
        findOverride(overrides, value, owner),
        { shouldDirty: true },
      );
  };
  const claimEntry = (entryIndex: number) => {
    const entry = form.getValues(
      `${entryPath}.${entryIndex}`,
    ) as RepositoryEntryDraft;
    if (validateName(entry.repository, entryIndex) !== true) return;
    applyName(entry.repository, entryIndex);
    const linked = form.getValues(
      `${entryPath}.${entryIndex}.overrideIndex`,
    ) as number;
    form.setValue(`${entryPath}.${entryIndex}.ownsOverride`, linked >= 0, {
      shouldDirty: true,
    });
    form.setValue(
      `${entryPath}.${entryIndex}.sourceRepository`,
      entry.repository,
      { shouldDirty: true },
    );
  };

  const effective = (override?: RepositoryOverrideDraft) => ({
    ...Object.fromEntries(
      BOOLEAN_SETTINGS.map(({ name, fallback }) => [
        name,
        override?.[name] ?? defaults[name] ?? fallback,
      ]),
    ),
    ...Object.fromEntries(
      LIST_SETTINGS.map(({ name }) => [
        name,
        override?.[name] ?? defaults[name] ?? [],
      ]),
    ),
  });
  const writeEntrySetting = (
    entryIndex: number,
    name: string,
    value: unknown,
  ) => {
    const entry = form.getValues(
      `${entryPath}.${entryIndex}`,
    ) as RepositoryEntryDraft;
    if (entry.overrideIndex >= 0 && overrides[entry.overrideIndex]) {
      form.setValue(
        `${prefix}.repositoryOverrides.${entry.overrideIndex}.${name}`,
        value,
        { shouldDirty: true },
      );
    } else {
      const index = overrides.length;
      append(
        githubRepositoryOverrideDraft({
          repository: entry.repository.trim(),
          [name]: value,
        }),
      );
      form.setValue(`${entryPath}.${entryIndex}.overrideIndex`, index, {
        shouldDirty: true,
      });
      form.setValue(`${entryPath}.${entryIndex}.ownsOverride`, true);
      form.setValue(
        `${entryPath}.${entryIndex}.sourceRepository`,
        entry.repository,
      );
    }
  };
  const entryRow = (
    entry: RepositoryEntryDraft,
    entryIndex: number,
    key: string,
  ) => {
    const matched =
      entry.overrideIndex >= 0 ? overrides[entry.overrideIndex] : undefined;
    const name = entry.repository.trim() || "New repository";
    const path = `${entryPath}.${entryIndex}.repository`;
    const error = Boolean(defaultValue(form.formState.errors, path));
    return (
      <fieldset key={key} aria-label={`Repository ${name}`}>
        <Disclosure
          title={name}
          summary={summary(matched)}
          open={
            openKey === key ||
            error ||
            (openKey === "new-entry" &&
              entryIndex === (entries?.length ?? 0) - 1)
          }
          onOpenChange={(next) => setOpenKey(next ? key : null)}
          actions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove repository ${name}`}
              onClick={() => {
                const shared = (
                  form.getValues(entryPath) as RepositoryEntryDraft[]
                ).some(
                  (other, index) =>
                    index !== entryIndex &&
                    other.overrideIndex === entry.overrideIndex,
                );
                if (matched && entry.ownsOverride && !shared)
                  removeSavedSettings(entry.overrideIndex, true);
                removeEntry(entryIndex);
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
              validate: (value: string) => validateName(value, entryIndex),
            }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Repository</FormLabel>
                <FormDescription>
                  A repository name or owner/repo. Renaming keeps this entry's
                  settings.
                </FormDescription>
                <FormControl>
                  <Input
                    placeholder="owner/repo"
                    {...field}
                    onChange={(event) => {
                      field.onChange(event.target.value);
                      applyName(event.target.value, entryIndex);
                    }}
                    onBlur={() => {
                      field.onBlur();
                      claimEntry(entryIndex);
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <RepositoryControls
            form={form}
            prefix={`${entryPath}.${entryIndex}.settings`}
            values={effective(matched)}
            disabled={validateName(entry.repository, entryIndex) !== true}
            onChange={(setting, value) =>
              writeEntrySetting(entryIndex, setting, value)
            }
          />
        </Disclosure>
      </fieldset>
    );
  };
  const overrideRow = (index: number, key: string) => {
    const name = overrides[index]?.repository || "New repository";
    const path = `${prefix}.repositoryOverrides.${index}.repository`;
    const error = Boolean(defaultValue(form.formState.errors, path));
    return (
      <fieldset
        key={key}
        aria-label={`Repository ${name}${mode === "selected" ? " (inactive)" : ""}`}
      >
        <Disclosure
          title={name}
          summary={`${summary(overrides[index])}${mode === "selected" ? " · Inactive" : ""}`}
          open={
            openKey === key ||
            error ||
            (openKey === "new-override" && index === overrides.length - 1)
          }
          onOpenChange={(next) => setOpenKey(next ? key : null)}
          actions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove saved settings for ${name}`}
              onClick={() => removeSavedSettings(index)}
            >
              Remove
            </Button>
          }
        >
          <FormField
            control={form.control}
            name={path}
            rules={{
              required: "Repository is required",
              validate: {
                format: (value: string) =>
                  /^[^/\\\s,]+(?:\/[^/\\\s,]+)?$/.test(value.trim()) ||
                  "Use a repository name or owner/repo",
                unique: (value: string) =>
                  (
                    form.getValues(
                      `${prefix}.repositoryOverrides`,
                    ) as RepositoryOverrideDraft[]
                  ).filter(
                    (entry) =>
                      entry.repository.trim().toLowerCase() ===
                      value.trim().toLowerCase(),
                  ).length === 1 || "Repository settings must be unique",
              },
            }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Repository</FormLabel>
                <FormDescription>
                  A bare name uses the configured owner. A matching owner/repo
                  takes precedence.
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
            prefix={`${prefix}.repositoryOverrides.${index}`}
            values={effective(overrides[index])}
          />
        </Disclosure>
      </fieldset>
    );
  };
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={selectionId}>Repository selection</Label>
        <Select
          value={mode}
          onValueChange={(value: "all" | "selected") => {
            setMode(value);
            form.setValue(`${prefix}.repositorySelectionMode`, value, {
              shouldDirty: true,
            });
            if (value === "all") {
              form.setValue(`${prefix}.repos`, [], { shouldDirty: true });
              form.clearErrors([`${prefix}.repos`, entryPath]);
            } else {
              const current = form.getValues(
                `${prefix}.repositoryOverrides`,
              ) as RepositoryOverrideDraft[];
              for (const [index, entry] of (
                (form.getValues(entryPath) as
                  | RepositoryEntryDraft[]
                  | undefined) ?? []
              ).entries()) {
                const overrideIndex = findOverride(
                  current,
                  entry.repository,
                  owner,
                );
                form.setValue(
                  `${entryPath}.${index}.overrideIndex`,
                  overrideIndex,
                );
                form.setValue(
                  `${entryPath}.${index}.ownsOverride`,
                  overrideIndex >= 0,
                );
                form.setValue(
                  `${entryPath}.${index}.sourceRepository`,
                  entry.repository,
                );
              }
            }
          }}
        >
          <SelectTrigger id={selectionId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All accessible repositories</SelectItem>
            <SelectItem value="selected">Selected repositories</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <FormField
        control={form.control}
        name={`${prefix}.repos`}
        rules={{
          validate: () =>
            mode === "all" ||
            ((form.getValues(entryPath) as RepositoryEntryDraft[] | undefined)
              ?.length ?? 0) > 0 ||
            "Add at least one repository or choose All accessible repositories.",
        }}
        render={() => (
          <FormItem>
            <FormMessage />
          </FormItem>
        )}
      />
      {mode === "all" && (
        <fieldset aria-label="All repositories">
          <Disclosure
            title="All repositories"
            summary={summary()}
            open={openKey === "all"}
            onOpenChange={(open) => setOpenKey(open ? "all" : null)}
          >
            <RepositoryControls
              form={form}
              prefix={prefix}
              values={effective()}
            />
          </Disclosure>
        </fieldset>
      )}
      <div hidden={mode === "all"} className="space-y-2">
        {entryFields.map((field, index) =>
          entries?.[index] ? entryRow(entries[index], index, field.id) : null,
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            appendEntry({
              repository: "",
              overrideIndex: -1,
              ownsOverride: false,
              sourceRepository: "",
            });
            setOpenKey("new-entry");
          }}
        >
          <Plus />
          <span>Add repository</span>
        </Button>
      </div>
      {otherOverrides.length > 0 && (
        <div className="space-y-2">
          {mode === "selected" && (
            <InlineNotice variant="neutral">
              <Info />
              <InlineNoticeText>
                Saved settings for unselected repositories or shadowed bare
                names are inactive and kept if needed again.
              </InlineNoticeText>
            </InlineNotice>
          )}
          {otherOverrides.map(({ field, index }) =>
            overrideRow(index, field.id),
          )}
        </div>
      )}
      {mode === "all" && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            append(githubRepositoryOverrideDraft({ repository: "" }));
            setOpenKey("new-override");
          }}
        >
          <Plus />
          <span>Add repository</span>
        </Button>
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
