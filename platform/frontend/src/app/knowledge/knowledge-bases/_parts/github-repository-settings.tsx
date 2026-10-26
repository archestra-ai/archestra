"use client";

import { ChevronDown, Info, Plus } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
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
  return [
    ...new Map(
      entries
        .map((entry: string) => entry.trim())
        .filter(Boolean)
        .map((entry: string) => [entry.toLowerCase(), entry]),
    ).values(),
  ] as string[];
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
  const overrides = canonical ?? legacy ?? [];
  const selected = repositories(form.watch(`${prefix}.repos`));
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
  const defaults = form.watch(prefix) as Record<string, unknown>;
  const matched = new Set(
    selected
      .map((repository) => findOverride(overrides, repository, owner))
      .filter((index) => index >= 0),
  );
  const otherOverrides = fields
    .map((field, index) => ({ field, index }))
    .filter(({ index }) => mode === "all" || !matched.has(index));
  const summary = (override?: RepositoryOverrideDraft) =>
    BOOLEAN_SETTINGS.map(
      ({ name, label, fallback }) =>
        `${label.replace("Include ", "")}: ${(override?.[name] ?? defaults[name] ?? fallback) ? "on" : "off"}`,
    ).join(" · ");
  const resetRepository = (index: number) => {
    const repository = overrides[index].repository.trim().toLowerCase();
    const identity = repository.includes("/")
      ? repository
      : `${owner.toLowerCase()}/${repository}`;
    remove(
      repository
        ? overrides.flatMap((entry, entryIndex) => {
            const candidate = entry.repository.trim().toLowerCase();
            return (candidate.includes("/")
              ? candidate
              : `${owner.toLowerCase()}/${candidate}`) === identity
              ? [entryIndex]
              : [];
          })
        : index,
    );
    setOpenKey(null);
  };
  const row = (
    repository: string,
    index: number,
    key: string,
    editable: boolean,
    inactive = false,
  ) => {
    const customized = index >= 0;
    const error =
      customized &&
      Boolean(
        defaultValue(
          form.formState.errors,
          `${prefix}.repositoryOverrides.${index}.repository`,
        ),
      );
    return (
      <fieldset
        key={key}
        aria-label={`Repository ${repository || "new override"}${inactive ? " (inactive)" : ""}`}
      >
        <Disclosure
          title={repository || "New repository override"}
          summary={`${summary(customized ? overrides[index] : undefined)} · ${customized ? "Custom settings" : "Uses repository defaults"}${inactive ? " · Inactive" : ""}`}
          open={
            openKey === key ||
            error ||
            (openKey === "new" && index === overrides.length - 1 && editable)
          }
          onOpenChange={(open) => setOpenKey(open ? key : null)}
          actions={
            customized ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  resetRepository(index);
                }}
                aria-label={`Reset ${repository || "repository"} to defaults${inactive ? " (inactive)" : ""}`}
              >
                Reset to defaults
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  append(githubRepositoryOverrideDraft({ repository }));
                  setOpenKey(key);
                }}
                aria-label={`Customize ${repository}`}
              >
                Customize
              </Button>
            )
          }
        >
          {customized ? (
            <OverrideFields
              form={form}
              prefix={prefix}
              index={index}
              defaults={defaults}
              editableRepository={editable}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              All settings inherit the repository defaults. Customize only the
              settings that differ.
            </p>
          )}
        </Disclosure>
      </fieldset>
    );
  };
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Repository settings</h3>
        <p className="text-sm text-muted-foreground">
          Choose the repositories, then set defaults and customize individual
          repositories.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={selectionId}>Repository selection</Label>
        <Select
          value={mode}
          onValueChange={(value: "all" | "selected") => {
            setMode(value);
            if (value === "all") {
              form.setValue(`${prefix}.repos`, "", { shouldDirty: true });
              form.clearErrors(`${prefix}.repos`);
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
      <div hidden={mode === "all"}>
        <FormField
          control={form.control}
          name={`${prefix}.repos`}
          rules={{
            validate: {
              selected: (value) =>
                mode === "all" ||
                repositories(value).length > 0 ||
                "Select at least one repository or choose All accessible repositories.",
              format: (value) =>
                mode === "all" ||
                repositories(value).every((repository) =>
                  /^[^/\\\s]+(?:\/[^/\\\s]+)?$/.test(repository),
                ) ||
                "Use repository names or owner/repo entries.",
            },
          }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Repositories</FormLabel>
              <FormDescription>
                Comma-separated names or owner/repo entries. Clearing this list
                does not enable discovery.
              </FormDescription>
              <FormControl>
                <Input
                  placeholder="repo-a, owner/repo-b"
                  {...field}
                  value={joinIfArray(field.value)}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
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
      <div className="space-y-2">
        {mode === "selected" &&
          selected.map((repository) =>
            row(
              repository,
              findOverride(overrides, repository, owner),
              `selected:${repository.toLowerCase()}`,
              false,
            ),
          )}
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
            row(
              overrides[index]?.repository ?? "",
              index,
              field.id,
              true,
              mode === "selected",
            ),
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
            setOpenKey("new");
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
