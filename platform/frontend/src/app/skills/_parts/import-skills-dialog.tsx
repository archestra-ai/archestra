"use client";

import type { RowSelectionState } from "@tanstack/react-table";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Info,
  Loader2,
  PackageSearch,
  SearchX,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { RepositoryBar } from "@/components/git/git-setup-chrome";
import {
  gitAuthFields,
  gitRepositoryUrlWithRef,
  resolveGitRepository,
} from "@/components/git/git-source";
import {
  GitSourceStepBody,
  GitSourceStepFooter,
  gitSourceStepDescription,
  useGitSourceSteps,
} from "@/components/git/git-source-steps";
import {
  ImportSelectionDialog,
  ImportSelectionList,
  ImportSettings,
} from "@/components/git/import-selection";
import {
  type InitialPermissionGrant,
  InitialResourcePermissions,
} from "@/components/initial-resource-permissions";
import { SearchInput } from "@/components/search-input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BulkRangeSelectionController } from "@/lib/bulk-range-selection";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useDiscoverGithubSkills,
  useImportGithubSkills,
  usePreviewGithubSkill,
} from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils/tailwind";
import { SkillPreviewDialog } from "./skill-preview-dialog";

/**
 * Skill metadata already held from the local skill index — enough to render the
 * confirm step without re-scanning the whole repository over the network.
 */
export interface IndexedSkillSelection {
  skillPath: string;
  name: string;
  description: string;
  compatibility: string | null;
  fileCount: number;
}

/**
 * A row on the select step: exactly the fields the step renders. Discovered
 * rows (a subset of the discover response) carry a server-checked `exists`
 * collision flag; indexed rows haven't been checked, so they enter as
 * importable and a name collision surfaces at import time instead (the
 * import response reports it as skipped and the dialog stays open).
 */
interface SelectStepSkill {
  skillPath: string;
  name: string;
  description: string;
  compatibility: string | null;
  fileCount: number;
  exists: boolean;
}

export function ImportSkillsDialog({
  open,
  onOpenChange,
  onImported,
  initialRepoUrl = "",
  initialSkill,
  autoDiscover = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: (skillIds: string[]) => void;
  initialRepoUrl?: string;
  initialSkill?: IndexedSkillSelection;
  autoDiscover?: boolean;
}) {
  const discover = useDiscoverGithubSkills();
  const importSkills = useImportGithubSkills();
  const appName = useAppName();
  const source = useGitSourceSteps();

  const [discovered, setDiscovered] = useState<SelectStepSkill[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rangeSelection = useRef(new BulkRangeSelectionController());
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [previewSkillPath, setPreviewSkillPath] = useState<string | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [initialGrants, setInitialGrants] = useState<InitialPermissionGrant[]>(
    [],
  );
  // pull schedule for every skill selected in this import: imports are
  // always synced from the repo and read-only here until disconnected.
  const [syncInterval, setSyncInterval] = useState<"15m" | "1h" | "1d">("1d");

  // What the routes read: the repository (a /tree/<branch> URL when a branch
  // is set), the folder, and the provider with its credential.
  const resolved = source.resolved;
  const repositoryFields = resolved.ok
    ? {
        repoUrl: gitRepositoryUrlWithRef(resolved),
        ...(resolved.subpath && { path: resolved.subpath }),
        ...source.auth,
      }
    : null;

  // strict null check: a repo-root skill's path is "", which is still a
  // previewable selection
  const previewBody =
    previewSkillPath !== null && repositoryFields
      ? { ...repositoryFields, skillPath: previewSkillPath }
      : null;
  const { data: previewData, isPending: isPreviewLoading } =
    usePreviewGithubSkill(previewBody);

  const reset = () => {
    source.reset();
    setDiscovered(null);
    setSelected(new Set());
    rangeSelection.current = new BulkRangeSelectionController();
    setSearch("");
    setSelectedOnly(false);
    setPreviewSkillPath(null);
    setDiscoverError(null);
    setInitialGrants([]);
    setSyncInterval("1d");
  };

  const backToRepository = () => {
    setDiscovered(null);
    setSearch("");
    setSelectedOnly(false);
    setPreviewSkillPath(null);
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) reset();
    onOpenChange(isOpen);
  };

  const runDiscover = async (fields: NonNullable<typeof repositoryFields>) => {
    setDiscoverError(null);
    const { data, errorMessage } = await discover.mutateAsync(fields);
    if (data) {
      setDiscovered(data.skills);
      const importableSkills = data.skills.filter((s) => !s.exists);
      setSelected(new Set(importableSkills.map((s) => s.skillPath)));
    } else if (errorMessage) {
      setDiscoverError(errorMessage);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: only fire on open
  useEffect(() => {
    if (!open || !initialRepoUrl) return;
    // The skill index lists public github.com repositories: skip straight
    // past the host and access steps.
    source.startOnPublicGithub(initialRepoUrl);
    if (!autoDiscover) return;
    if (initialSkill) {
      // launched from the skill index: the exact skill is already known, so
      // skip the repo-wide scan and go straight to the confirm step.
      setDiscovered([{ ...initialSkill, exists: false }]);
      setSelected(new Set([initialSkill.skillPath]));
      return;
    }
    const initial = resolveGitRepository({
      provider: "github",
      access: { kind: "public" },
      input: initialRepoUrl,
    });
    runDiscover({
      repoUrl: initial.ok ? initial.repoUrl : initialRepoUrl,
      ...gitAuthFields({ provider: "github", access: { kind: "public" } }),
    });
  }, [open]);

  const handleImport = async () => {
    if (!repositoryFields) return;
    const result = await importSkills.mutateAsync({
      ...repositoryFields,
      skillPaths: [...selected],
      initialGrants: initialGrants.map(({ subject, actions }) => ({
        subject,
        actions,
      })),
      sync: { interval: syncInterval },
    });
    // only navigate away when something was actually created; if every selected
    // skill was already in the org (created: [], skipped: [...]) the import was
    // a no-op, so keep the dialog open — the mutation's toast reports the skip.
    if (result && result.created.length > 0) {
      handleClose(false);
      onImported?.(result.created.map((skill) => skill.id));
    }
  };

  const toggle = (skillPath: string, range: boolean) => {
    setSelected((prev) => {
      const next = rangeSelection.current.update({
        current: toRowSelectionState(prev),
        orderedIds: selectableFiltered.map((skill) => skill.skillPath),
        targetId: skillPath,
        range,
      });
      return toSelectionSet(next);
    });
  };

  const filteredSkills = useMemo(() => {
    if (!discovered) return [];
    const q = search.trim().toLowerCase();
    return discovered.filter(
      (s) =>
        (!selectedOnly || selected.has(s.skillPath)) &&
        (!q ||
          s.name.toLowerCase().includes(q) ||
          s.description?.toLowerCase().includes(q) ||
          s.skillPath.toLowerCase().includes(q)),
    );
  }, [discovered, search, selectedOnly, selected]);

  const selectableFiltered = useMemo(
    () => filteredSkills.filter((s) => !s.exists),
    [filteredSkills],
  );

  const allFilteredSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((s) => selected.has(s.skillPath));

  const someFilteredSelected =
    !allFilteredSelected &&
    selectableFiltered.some((s) => selected.has(s.skillPath));

  const toggleAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const s of selectableFiltered) next.delete(s.skillPath);
      } else {
        for (const s of selectableFiltered) next.add(s.skillPath);
      }
      return next;
    });
  };

  const isSelectStep = discovered !== null;
  const isAutoDiscovering = autoDiscover && !isSelectStep && !discoverError;
  const repositoryBar = (
    <RepositoryBar
      provider={source.provider}
      label={resolved.ok ? resolved.label : source.repository.input}
      avatarUrl={resolved.ok ? resolved.avatarUrl : null}
      onChange={autoDiscover ? undefined : backToRepository}
    />
  );

  const totalImportable = discovered?.filter((s) => !s.exists).length ?? 0;
  const totalExisting = discovered?.filter((s) => s.exists).length ?? 0;

  return (
    <ImportSelectionDialog
      open={open}
      onOpenChange={handleClose}
      title={
        isAutoDiscovering
          ? "Scanning repository"
          : isSelectStep
            ? "Select skills to import"
            : "Import skills"
      }
      description={
        isAutoDiscovering
          ? "Looking for SKILL.md folders."
          : isSelectStep
            ? "Choose which skills to add."
            : gitSourceStepDescription({
                step: source.step,
                provider: source.provider,
              })
      }
      size="medium"
      selecting={isSelectStep}
      footer={
        isAutoDiscovering ? (
          <Button variant="outline" onClick={() => handleClose(false)}>
            <span>Cancel</span>
          </Button>
        ) : isSelectStep ? (
          <>
            {autoDiscover ? (
              <Button variant="outline" onClick={() => handleClose(false)}>
                <span>Cancel</span>
              </Button>
            ) : (
              <Button variant="outline" onClick={backToRepository}>
                <span>Back</span>
              </Button>
            )}
            <Button
              onClick={handleImport}
              disabled={selected.size === 0 || importSkills.isPending}
            >
              {importSkills.isPending ? (
                <Loader2 className="animate-spin" />
              ) : null}
              <span>
                {importSkills.isPending
                  ? "Importing…"
                  : `Import${selected.size > 0 ? ` (${selected.size})` : ""}`}
              </span>
            </Button>
          </>
        ) : (
          <GitSourceStepFooter
            source={source}
            onCancel={() => handleClose(false)}
            findLabel="Find skills"
            finding={discover.isPending}
            onFind={() => repositoryFields && runDiscover(repositoryFields)}
          />
        )
      }
    >
      {isAutoDiscovering ? (
        <div className="flex flex-col items-center justify-center gap-4 py-10">
          <Avatar className="size-14">
            <AvatarImage
              src={
                resolved.ok && resolved.avatarUrl
                  ? `${resolved.avatarUrl}?size=128`
                  : undefined
              }
              alt=""
            />
            <AvatarFallback>
              <PackageSearch className="size-6 text-muted-foreground" />
            </AvatarFallback>
          </Avatar>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span className="font-mono text-foreground">
              {resolved.ok ? resolved.label : initialRepoUrl}
            </span>
          </div>
        </div>
      ) : isSelectStep ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {discovered.length === 0 ? (
            <>
              {repositoryBar}
              <div className="px-4 py-8">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <SearchX />
                    </EmptyMedia>
                    <EmptyTitle>No SKILL.md directories</EmptyTitle>
                    <EmptyDescription>
                      Try another repository or folder.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            </>
          ) : (
            <>
              <div className="shrink-0 border-b bg-background">
                {repositoryBar}
                <div className="space-y-2 px-4 py-3">
                  <SearchInput
                    value={search}
                    onSearchChange={setSearch}
                    syncQueryParams={false}
                    placeholder="Search by name, description, or path"
                    className="relative w-full"
                  />
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <div className="flex shrink-0 items-center gap-2">
                      <Checkbox
                        id="import-skills-select-all"
                        checked={
                          allFilteredSelected
                            ? true
                            : someFilteredSelected
                              ? "indeterminate"
                              : false
                        }
                        disabled={selectableFiltered.length === 0}
                        onCheckedChange={toggleAllFiltered}
                      />
                      <label
                        htmlFor="import-skills-select-all"
                        className="cursor-pointer text-xs font-medium text-muted-foreground select-none hover:text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-50 peer-disabled:hover:text-muted-foreground"
                      >
                        {allFilteredSelected
                          ? search.trim() || selectedOnly
                            ? "Deselect visible"
                            : "Deselect all"
                          : search.trim()
                            ? `Select all (${selectableFiltered.length} visible)`
                            : "Select all"}
                      </label>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant={selectedOnly ? "secondary" : "ghost"}
                        size="xs"
                        aria-pressed={selectedOnly}
                        onClick={() => setSelectedOnly((value) => !value)}
                      >
                        <span>Selected ({selected.size})</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={selected.size === 0}
                        onClick={() => {
                          setSelected(new Set());
                          rangeSelection.current =
                            new BulkRangeSelectionController();
                        }}
                      >
                        <span>Clear selection</span>
                      </Button>
                    </div>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {selected.size} of {totalImportable} selected
                      {totalExisting > 0 && ` · ${totalExisting} imported`}
                    </span>
                  </div>
                </div>
              </div>
              <ImportSelectionList label="Skills to import">
                {filteredSkills.length === 0 ? (
                  <div className="px-4 py-8">
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <SearchX />
                        </EmptyMedia>
                        <EmptyTitle>No matches</EmptyTitle>
                        <EmptyDescription>
                          {selectedOnly
                            ? "No selected skills match your search."
                            : `No skills match “${search}”.`}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </div>
                ) : (
                  <ul className="divide-y">
                    {filteredSkills.map((skill) => {
                      const isSelected = selected.has(skill.skillPath);
                      return (
                        <li
                          key={skill.skillPath}
                          className={cn(
                            "group relative flex items-center gap-3 px-4 py-3 transition-colors",
                            skill.exists
                              ? "bg-muted/20"
                              : isSelected
                                ? "bg-primary/5"
                                : "hover:bg-muted/40",
                          )}
                        >
                          <label
                            htmlFor={`import-skill-${skill.skillPath}`}
                            className={cn(
                              "flex min-w-0 flex-1 items-center gap-3 text-left",
                              skill.exists
                                ? "cursor-not-allowed"
                                : "cursor-pointer",
                            )}
                          >
                            {skill.exists ? (
                              <CheckCircle2
                                className="size-4 shrink-0 text-muted-foreground"
                                aria-hidden
                              />
                            ) : (
                              <Checkbox
                                id={`import-skill-${skill.skillPath}`}
                                checked={isSelected}
                                onClick={(event) => {
                                  event.preventDefault();
                                  toggle(skill.skillPath, event.shiftKey);
                                }}
                                className="shrink-0"
                                aria-label={
                                  isSelected
                                    ? `Deselect ${skill.name}`
                                    : `Select ${skill.name}`
                                }
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    "truncate text-sm font-medium",
                                    skill.exists && "text-muted-foreground",
                                  )}
                                >
                                  {skill.name}
                                </span>
                                {skill.compatibility && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span
                                        role="img"
                                        aria-label={`Compatibility: ${skill.compatibility}`}
                                        className="inline-flex shrink-0 items-center gap-1 rounded border border-dashed px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
                                      >
                                        <Info className="size-3" />
                                        compatibility
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs">
                                      {skill.compatibility}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                                {skill.exists && (
                                  <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                                    Imported
                                  </span>
                                )}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {skill.description || (
                                  <span className="italic">No description</span>
                                )}
                              </div>
                            </div>
                          </label>
                          <div className="flex shrink-0 items-center gap-3">
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {skill.fileCount}{" "}
                              {skill.fileCount === 1 ? "file" : "files"}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() =>
                                setPreviewSkillPath(skill.skillPath)
                              }
                              aria-label={`Preview ${skill.name}`}
                            >
                              <Eye className="size-3.5" />
                              Preview
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </ImportSelectionList>
            </>
          )}
          {discovered.length > 0 ? (
            <ImportSettings>
              <div className="space-y-2">
                <Label htmlFor="skill-sync-interval">Keep in sync</Label>
                <FieldDescription>
                  Read-only in {appName} until you disconnect.
                </FieldDescription>
                <Select
                  value={syncInterval}
                  onValueChange={(value) =>
                    setSyncInterval(value as typeof syncInterval)
                  }
                >
                  <SelectTrigger id="skill-sync-interval" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="15m">Every 15 minutes</SelectItem>
                    <SelectItem value="1h">Every hour</SelectItem>
                    <SelectItem value="1d">Once a day</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <InitialResourcePermissions
                resource="skill"
                grants={initialGrants}
                onChange={setInitialGrants}
              />
            </ImportSettings>
          ) : null}
        </div>
      ) : (
        <div className="space-y-5">
          <GitSourceStepBody
            source={source}
            lastLabel="Skills"
            withSubpath
            subpathPlaceholder="skills"
          />
          {discoverError && source.step === "repo" ? (
            <InlineNotice variant="error">
              <AlertTriangle />
              <span className="font-medium">Couldn’t read that repository</span>
              <InlineNoticeText>
                <span>{discoverError}</span>
                {source.access?.kind === "public" ? (
                  <span> Private? Change the access above.</span>
                ) : null}
              </InlineNoticeText>
            </InlineNotice>
          ) : null}
        </div>
      )}
      <SkillPreviewDialog
        open={previewSkillPath !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setPreviewSkillPath(null);
        }}
        preview={previewData ?? null}
        isLoading={isPreviewLoading}
      />
    </ImportSelectionDialog>
  );
}

function toRowSelectionState(selected: Set<string>): RowSelectionState {
  return Object.fromEntries([...selected].map((id) => [id, true]));
}

function toSelectionSet(selection: RowSelectionState): Set<string> {
  return new Set(
    Object.entries(selection)
      .filter(([, selected]) => selected)
      .map(([id]) => id),
  );
}
