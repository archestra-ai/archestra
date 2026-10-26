"use client";

import { ChevronDown, Info, Plus } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  type FieldValues,
  type UseFormReturn,
  useFieldArray,
} from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
    label: "Labels to Skip",
    placeholder: "wontfix, duplicate",
    description:
      "Comma-separated labels to skip on issues and pull requests. Blank skips no labels.",
  },
  {
    name: "fileTypes",
    label: "File Types",
    placeholder: ".md, .yaml, Dockerfile",
    description:
      "Comma-separated extensions or file names. Use * for all text files. Blank uses Markdown and YAML.",
  },
  {
    name: "includePaths",
    label: "Include paths",
    placeholder: "docs, packages/api/src",
    description:
      "Comma-separated files or folders, relative to the repository root, not globs. Blank includes the whole repository.",
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
  const [defaultsOpen, setDefaultsOpen] = useState(false);
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
  const resetRepository = (index: number) => {
    const repository = overrides[index].repository;
    const indices = repository.trim()
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
      return "This repository already has saved overrides. Reset them before renaming this entry.";
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
  const entryRow = (
    entry: RepositoryEntryDraft,
    entryIndex: number,
    key: string,
  ) => {
    const customized =
      entry.overrideIndex >= 0 && Boolean(overrides[entry.overrideIndex]);
    const name = entry.repository.trim() || "New repository";
    const path = `${entryPath}.${entryIndex}.repository`;
    const error = Boolean(defaultValue(form.formState.errors, path));
    const open =
      openKey === key ||
      error ||
      (openKey === "new-entry" && entryIndex === (entries?.length ?? 0) - 1);
    return (
      <fieldset key={key} aria-label={`Repository ${name}`}>
        <Disclosure
          title={name}
          summary={`${summary(customized ? overrides[entry.overrideIndex] : undefined)} · ${customized ? "Custom settings" : "Uses repository defaults"}`}
          open={open}
          onOpenChange={(next) => setOpenKey(next ? key : null)}
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Edit repository ${name}`}
                onClick={() => setOpenKey(key)}
              >
                Edit
              </Button>
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
                  if (customized && entry.ownsOverride && !shared)
                    resetRepository(entry.overrideIndex);
                  removeEntry(entryIndex);
                  setOpenKey(null);
                }}
              >
                Remove
              </Button>
            </>
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
                  custom settings.
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
          {customized ? (
            <>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Reset ${name} to defaults`}
                  onClick={() => resetRepository(entry.overrideIndex)}
                >
                  Reset to defaults
                </Button>
              </div>
              <OverrideFields
                form={form}
                prefix={prefix}
                index={entry.overrideIndex}
                defaults={defaults}
                editableRepository={false}
              />
            </>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                All settings inherit the repository defaults.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Customize ${name}`}
                disabled={!entry.repository.trim()}
                onClick={() => {
                  const index = overrides.length;
                  append(
                    githubRepositoryOverrideDraft({
                      repository: entry.repository.trim(),
                    }),
                  );
                  form.setValue(
                    `${entryPath}.${entryIndex}.overrideIndex`,
                    index,
                    { shouldDirty: true },
                  );
                  form.setValue(
                    `${entryPath}.${entryIndex}.ownsOverride`,
                    true,
                    { shouldDirty: true },
                  );
                  form.setValue(
                    `${entryPath}.${entryIndex}.sourceRepository`,
                    entry.repository,
                    { shouldDirty: true },
                  );
                }}
              >
                Customize
              </Button>
            </div>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={async () => {
                if (await form.trigger(path)) {
                  claimEntry(entryIndex);
                  setOpenKey(null);
                }
              }}
            >
              Done
            </Button>
          </div>
        </Disclosure>
      </fieldset>
    );
  };
  const overrideRow = (index: number, key: string) => {
    const repository = overrides[index]?.repository ?? "";
    const name = repository || "New repository override";
    const error = Boolean(
      defaultValue(
        form.formState.errors,
        `${prefix}.repositoryOverrides.${index}.repository`,
      ),
    );
    return (
      <fieldset
        key={key}
        aria-label={`Repository ${name}${mode === "selected" ? " (inactive)" : ""}`}
      >
        <Disclosure
          title={name}
          summary={`${summary(overrides[index])} · Custom settings${mode === "selected" ? " · Inactive" : ""}`}
          open={
            openKey === key ||
            error ||
            (openKey === "new-override" && index === overrides.length - 1)
          }
          onOpenChange={(next) => setOpenKey(next ? key : null)}
          actions={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Reset ${name} to defaults${mode === "selected" ? " (inactive)" : ""}`}
              onClick={() => resetRepository(index)}
            >
              Reset to defaults
            </Button>
          }
        >
          <OverrideFields
            form={form}
            prefix={prefix}
            index={index}
            defaults={defaults}
            editableRepository
          />
        </Disclosure>
      </fieldset>
    );
  };
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Repository settings</h3>
        <p className="text-sm text-muted-foreground">
          Choose repositories and customize their settings. Other repositories
          keep the defaults.
        </p>
      </div>
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
              // Rules can be renamed in discovery mode while selected rows are hidden.
              const currentOverrides = form.getValues(
                `${prefix}.repositoryOverrides`,
              ) as RepositoryOverrideDraft[];
              for (const [index, entry] of (
                (form.getValues(entryPath) as
                  | RepositoryEntryDraft[]
                  | undefined) ?? []
              ).entries()) {
                const overrideIndex = findOverride(
                  currentOverrides,
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
        <InlineNotice variant="neutral">
          <Info />
          <InlineNoticeText>
            All repositories available to the configured credential are
            discovered. Newly discovered repositories use the defaults unless an
            override matches.
          </InlineNoticeText>
        </InlineNotice>
      )}
      <Disclosure
        title="Repository defaults"
        summary={summary()}
        open={defaultsOpen}
        onOpenChange={setDefaultsOpen}
      >
        <SettingsFields form={form} prefix={prefix} />
      </Disclosure>
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
                Other overrides are inactive when their repository is not
                selected or a qualified override takes precedence. They are kept
                if needed again.
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
          <span>Add repository override</span>
        </Button>
      )}
    </div>
  );
}

function SettingsFields({ form, prefix }: Props) {
  const files = form.watch(`${prefix}.includeRepositoryFiles`) === true;
  return (
    <>
      <h4 className="text-sm font-medium">Issues and pull requests</h4>
      {BOOLEAN_SETTINGS.slice(0, 2).map((setting) => (
        <DefaultBoolean
          key={setting.name}
          form={form}
          prefix={prefix}
          setting={setting}
        />
      ))}
      <DefaultList form={form} prefix={prefix} setting={LIST_SETTINGS[0]} />
      <h4 className="text-sm font-medium">Repository files</h4>
      <DefaultBoolean
        form={form}
        prefix={prefix}
        setting={BOOLEAN_SETTINGS[2]}
      />
      {files &&
        LIST_SETTINGS.slice(1).map((setting) => (
          <DefaultList
            key={setting.name}
            form={form}
            prefix={prefix}
            setting={setting}
          />
        ))}
    </>
  );
}

function DefaultBoolean({
  form,
  prefix,
  setting,
}: Props & { setting: BooleanSetting }) {
  return (
    <FormField
      control={form.control}
      name={`${prefix}.${setting.name}`}
      render={({ field }) => (
        <FormItem className="flex items-center justify-between gap-3">
          <div>
            <FormLabel>{setting.label}</FormLabel>
            <FormDescription>{setting.description}</FormDescription>
          </div>
          <FormControl>
            <Switch
              checked={field.value ?? setting.fallback}
              onCheckedChange={field.onChange}
            />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

function DefaultList({
  form,
  prefix,
  setting,
}: Props & { setting: ListSetting }) {
  return (
    <FormField
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
              value={joinIfArray(field.value)}
            />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

function OverrideFields({
  form,
  prefix,
  index,
  defaults,
  editableRepository,
}: Props & {
  index: number;
  defaults: Record<string, unknown>;
  editableRepository: boolean;
}) {
  const path = `${prefix}.repositoryOverrides.${index}`;
  const override = form.watch(path) as RepositoryOverrideDraft;
  const files =
    override?.includeRepositoryFiles ??
    defaults.includeRepositoryFiles ??
    false;
  return (
    <>
      {editableRepository && (
        <FormField
          control={form.control}
          name={`${path}.repository`}
          rules={{
            required: "Repository is required",
            validate: {
              format: (value: string) =>
                /^[^/\\\s]+(?:\/[^/\\\s]+)?$/.test(value.trim()) ||
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
                ).length === 1 || "Repository overrides must be unique",
            },
          }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Repository</FormLabel>
              <FormDescription>
                A bare name uses the configured owner. A matching owner/repo
                override takes precedence.
              </FormDescription>
              <FormControl>
                <Input placeholder="owner/repo" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
      <h4 className="text-sm font-medium">Issues and pull requests</h4>
      {BOOLEAN_SETTINGS.slice(0, 2).map((setting) => (
        <OverrideBoolean
          key={setting.name}
          form={form}
          prefix={path}
          setting={setting}
          inherited={Boolean(defaults[setting.name] ?? setting.fallback)}
        />
      ))}
      <OverrideList
        form={form}
        prefix={path}
        setting={LIST_SETTINGS[0]}
        inherited={defaults.labelsToSkip}
      />
      <h4 className="text-sm font-medium">Repository files</h4>
      <OverrideBoolean
        form={form}
        prefix={path}
        setting={BOOLEAN_SETTINGS[2]}
        inherited={Boolean(defaults.includeRepositoryFiles ?? false)}
      />
      {files === true &&
        LIST_SETTINGS.slice(1).map((setting) => (
          <OverrideList
            key={setting.name}
            form={form}
            prefix={path}
            setting={setting}
            inherited={defaults[setting.name]}
          />
        ))}
    </>
  );
}

function OverrideBoolean({
  form,
  prefix,
  setting,
  inherited,
}: Props & { setting: BooleanSetting; inherited: boolean }) {
  return (
    <FormField
      control={form.control}
      name={`${prefix}.${setting.name}`}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{setting.label}</FormLabel>
          <Select
            value={
              field.value === undefined || field.value === null
                ? "inherit"
                : field.value
                  ? "true"
                  : "false"
            }
            onValueChange={(value) =>
              field.onChange(value === "inherit" ? null : value === "true")
            }
          >
            <FormControl>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value="inherit">
                <span>{`Use default (${inherited ? "on" : "off"})`}</span>
              </SelectItem>
              <SelectItem value="true">On</SelectItem>
              <SelectItem value="false">Off</SelectItem>
            </SelectContent>
          </Select>
          <FormDescription>{setting.description}</FormDescription>
        </FormItem>
      )}
    />
  );
}

function OverrideList({
  form,
  prefix,
  setting,
  inherited,
}: Props & { setting: ListSetting; inherited: unknown }) {
  const id = `${prefix}.${setting.name}.inherit`;
  return (
    <FormField
      control={form.control}
      name={`${prefix}.${setting.name}`}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{setting.label}</FormLabel>
          <div className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={field.value === undefined || field.value === null}
              onCheckedChange={(checked) =>
                field.onChange(checked ? null : joinIfArray(inherited))
              }
            />
            <Label htmlFor={id}>
              Use default {setting.label.toLowerCase()}
            </Label>
          </div>
          <FormDescription>{setting.description}</FormDescription>
          <FormControl>
            <Input
              placeholder={setting.placeholder}
              {...field}
              value={joinIfArray(field.value ?? inherited)}
              disabled={field.value === undefined || field.value === null}
            />
          </FormControl>
        </FormItem>
      )}
    />
  );
}
