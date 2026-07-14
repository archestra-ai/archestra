"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  Info,
  Loader2,
  PackageSearch,
  SearchX,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  GithubAuthConfigFields,
  type GithubAuthMethod,
} from "@/components/github-auth-config-fields";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useGithubAppConfigs } from "@/lib/github-app-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useDiscoverGithubSkills,
  useImportGithubSkills,
  usePreviewGithubSkill,
} from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils";
import { SkillEditorDialog } from "./skill-editor-dialog";
import { SkillScopeSelector } from "./skill-scope-selector";

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
  onImported?: () => void;
  initialRepoUrl?: string;
  initialSkill?: IndexedSkillSelection;
  autoDiscover?: boolean;
}) {
  const discover = useDiscoverGithubSkills();
  const importSkills = useImportGithubSkills();
  const { data: githubAppConfigs = [] } = useGithubAppConfigs();
  const appName = useAppName();

  const [repoUrl, setRepoUrl] = useState(initialRepoUrl);
  const [path, setPath] = useState("");
  const [authMethod, setAuthMethod] = useState<"pat" | "github_app">("pat");
  const [githubToken, setGithubToken] = useState("");
  const [githubAppConfigId, setGithubAppConfigId] = useState("");
  const [discovered, setDiscovered] = useState<SelectStepSkill[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [previewSkillPath, setPreviewSkillPath] = useState<string | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  // scope applies to every skill selected in this import
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  // PAT and GitHub App auth are mutually exclusive; the backend rejects both
  const githubAuthFields =
    authMethod === "github_app"
      ? githubAppConfigId
        ? { githubAppConfigId }
        : {}
      : githubToken.trim()
        ? { githubToken: githubToken.trim() }
        : {};

  // strict null check: a repo-root skill's path is "", which is still a
  // previewable selection
  const previewBody =
    previewSkillPath !== null
      ? {
          repoUrl,
          ...(path.trim() && { path: path.trim() }),
          ...githubAuthFields,
          skillPath: previewSkillPath,
        }
      : null;
  const { data: previewData, isPending: isPreviewLoading } =
    usePreviewGithubSkill(previewBody);

  const reset = () => {
    setRepoUrl("");
    setPath("");
    setAuthMethod("pat");
    setGithubToken("");
    setGithubAppConfigId("");
    setDiscovered(null);
    setSelected(new Set());
    setSearch("");
    setPreviewSkillPath(null);
    setDiscoverError(null);
    setScope("personal");
    setTeamIds([]);
  };

  const backToDiscover = () => {
    setDiscovered(null);
    setSearch("");
    setPreviewSkillPath(null);
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) reset();
    onOpenChange(isOpen);
  };

  const handleAuthMethodChange = (value: GithubAuthMethod) => {
    setAuthMethod(value);
    if (value === "pat") {
      setGithubAppConfigId("");
    }
  };

  const handleDiscover = async (overrideRepoUrl?: string) => {
    setDiscoverError(null);
    const { data, errorMessage } = await discover.mutateAsync({
      repoUrl: overrideRepoUrl ?? repoUrl,
      ...(path.trim() && { path: path.trim() }),
      ...githubAuthFields,
    });
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
    if (!open) return;
    setRepoUrl(initialRepoUrl);
    if (!autoDiscover) return;
    if (initialSkill) {
      // launched from the skill index: the exact skill is already known, so
      // skip the repo-wide scan and go straight to the confirm step.
      setDiscovered([{ ...initialSkill, exists: false }]);
      setSelected(new Set([initialSkill.skillPath]));
    } else if (initialRepoUrl) {
      handleDiscover(initialRepoUrl);
    }
  }, [open]);

  const handleImport = async () => {
    const result = await importSkills.mutateAsync({
      repoUrl,
      ...(path.trim() && { path: path.trim() }),
      ...githubAuthFields,
      skillPaths: [...selected],
      scope,
      teamIds: scope === "team" ? teamIds : [],
    });
    // only navigate away when something was actually created; if every selected
    // skill was already in the org (created: [], skipped: [...]) the import was
    // a no-op, so keep the dialog open — the mutation's toast reports the skip.
    if (result && result.created.length > 0) {
      handleClose(false);
      onImported?.();
    }
  };

  const toggle = (skillPath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(skillPath)) {
        next.delete(skillPath);
      } else {
        next.add(skillPath);
      }
      return next;
    });
  };

  const filteredSkills = useMemo(() => {
    if (!discovered) return [];
    const q = search.trim().toLowerCase();
    if (!q) return discovered;
    return discovered.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q) ||
        s.skillPath.toLowerCase().includes(q),
    );
  }, [discovered, search]);

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
  const hasGithubAuth =
    authMethod === "github_app"
      ? githubAppConfigId.length > 0
      : githubToken.trim().length > 0;

  const repoSlug = repoUrl
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const repoOwner = repoSlug.split("/")[0];

  const totalImportable = discovered?.filter((s) => !s.exists).length ?? 0;
  const totalExisting = discovered?.filter((s) => s.exists).length ?? 0;

  return (
    <StandardDialog
      open={open}
      onOpenChange={handleClose}
      title={
        isAutoDiscovering ? (
          "Scanning repository"
        ) : isSelectStep ? (
          autoDiscover ? (
            <span>Select skills to import</span>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={backToDiscover}
                aria-label="Go back"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span>Select skills to import</span>
            </div>
          )
        ) : (
          "Import skills from GitHub"
        )
      }
      description={
        isAutoDiscovering
          ? "Looking for SKILL.md directories in the repository."
          : isSelectStep
            ? "Choose which skills to add to your organization."
            : "Point at a repository containing one or more SKILL.md directories."
      }
      size="medium"
      bodyClassName={isSelectStep ? "p-0" : undefined}
      footer={
        isAutoDiscovering ? (
          <Button variant="outline" onClick={() => handleClose(false)}>
            Cancel
          </Button>
        ) : isSelectStep ? (
          <>
            {autoDiscover ? (
              <Button variant="outline" onClick={() => handleClose(false)}>
                Cancel
              </Button>
            ) : (
              <Button variant="outline" onClick={backToDiscover}>
                Back
              </Button>
            )}
            <Button
              onClick={handleImport}
              disabled={selected.size === 0 || importSkills.isPending}
            >
              {importSkills.isPending
                ? "Importing..."
                : `Import ${selected.size > 0 ? `(${selected.size})` : ""}`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => handleClose(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => handleDiscover()}
              disabled={!repoUrl.trim() || discover.isPending}
            >
              {discover.isPending ? "Discovering..." : "Discover"}
            </Button>
          </>
        )
      }
    >
      {isAutoDiscovering ? (
        <div className="flex flex-col items-center justify-center gap-4 py-10">
          <Avatar className="size-14">
            <AvatarImage
              src={`https://github.com/${repoOwner}.png?size=128`}
              alt=""
            />
            <AvatarFallback>
              <PackageSearch className="size-6 text-muted-foreground" />
            </AvatarFallback>
          </Avatar>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span className="font-mono text-foreground">{repoSlug}</span>
          </div>
        </div>
      ) : isSelectStep ? (
        <div className="flex flex-col">
          {discovered.length === 0 ? (
            <>
              <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-3">
                <Avatar className="size-8 shrink-0">
                  <AvatarImage
                    src={`https://github.com/${repoOwner}.png?size=64`}
                    alt=""
                  />
                  <AvatarFallback className="text-xs">
                    {repoOwner.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 truncate font-mono text-sm font-medium">
                  {repoSlug}
                </div>
                {!autoDiscover && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={backToDiscover}
                    className="shrink-0"
                  >
                    Change source
                  </Button>
                )}
              </div>
              <div className="px-4 py-8">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <SearchX />
                    </EmptyMedia>
                    <EmptyTitle>No SKILL.md directories</EmptyTitle>
                    <EmptyDescription>
                      This repository doesn’t contain any directories with a
                      SKILL.md manifest. Try a different repository or subpath.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            </>
          ) : (
            <>
              <div className="sticky top-0 z-10 border-b bg-background">
                <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-2.5">
                  <Avatar className="size-7 shrink-0">
                    <AvatarImage
                      src={`https://github.com/${repoOwner}.png?size=64`}
                      alt=""
                    />
                    <AvatarFallback className="text-xs">
                      {repoOwner.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1 truncate font-mono text-sm font-medium">
                    {repoSlug}
                  </div>
                  {!autoDiscover && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={backToDiscover}
                      className="shrink-0"
                    >
                      Change source
                    </Button>
                  )}
                </div>
                <div className="space-y-2 px-4 py-3">
                  <SearchInput
                    value={search}
                    onSearchChange={setSearch}
                    syncQueryParams={false}
                    placeholder="Search by name, description, or path"
                    className="relative w-full"
                  />
                  <div className="flex items-center justify-between gap-3">
                    <button
                      type="button"
                      disabled={selectableFiltered.length === 0}
                      onClick={toggleAllFiltered}
                      className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground select-none hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
                    >
                      <Checkbox
                        checked={
                          allFilteredSelected
                            ? true
                            : someFilteredSelected
                              ? "indeterminate"
                              : false
                        }
                        disabled={selectableFiltered.length === 0}
                        className="pointer-events-none"
                        tabIndex={-1}
                        aria-label="Select all visible skills"
                      />
                      <span>
                        {allFilteredSelected
                          ? "Deselect all"
                          : search.trim()
                            ? `Select all (${selectableFiltered.length} visible)`
                            : "Select all"}
                      </span>
                    </button>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {selected.size} of {totalImportable} selected
                      {totalExisting > 0 && ` · ${totalExisting} imported`}
                    </span>
                  </div>
                </div>
              </div>
              {filteredSkills.length === 0 ? (
                <div className="px-4 py-8">
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <SearchX />
                      </EmptyMedia>
                      <EmptyTitle>No matches</EmptyTitle>
                      <EmptyDescription>
                        No skills match “{search}”.
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
                        <button
                          type="button"
                          disabled={skill.exists}
                          onClick={() => toggle(skill.skillPath)}
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-3 text-left",
                            skill.exists
                              ? "cursor-not-allowed"
                              : "cursor-pointer",
                          )}
                          aria-label={
                            skill.exists
                              ? `${skill.name} (already imported)`
                              : isSelected
                                ? `Deselect ${skill.name}`
                                : `Select ${skill.name}`
                          }
                        >
                          {skill.exists ? (
                            <CheckCircle2
                              className="size-4 shrink-0 text-muted-foreground"
                              aria-hidden
                            />
                          ) : (
                            <Checkbox
                              checked={isSelected}
                              className="pointer-events-none shrink-0"
                              tabIndex={-1}
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
                        </button>
                        <div className="flex shrink-0 items-center gap-3">
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {skill.fileCount}{" "}
                            {skill.fileCount === 1 ? "file" : "files"}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                            onClick={() => setPreviewSkillPath(skill.skillPath)}
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
            </>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex gap-2.5 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <p>
              Importing copies the selected skills into your organization once.{" "}
              {appName} doesn’t pull from the repo afterward — later changes
              there won’t appear here, your edits here won’t go back to GitHub,
              and re-importing skips skills you’ve already imported.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-repo-url">Repository URL</Label>
            <Input
              id="skill-repo-url"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="github.com/owner/repo"
              autoFocus
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
            />
            <p className="text-sm text-muted-foreground">
              Any directory containing a{" "}
              <code className="font-mono">SKILL.md</code> with{" "}
              <code className="font-mono">name</code> and{" "}
              <code className="font-mono">description</code> frontmatter counts
              as a skill.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-subpath">
              Subpath
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </Label>
            <Input
              id="skill-subpath"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="packages/skills"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
            />
            <p className="text-sm text-muted-foreground">
              Restrict the scan to <code className="font-mono">SKILL.md</code>{" "}
              directories under this path.
            </p>
          </div>
          <GithubAuthConfigFields
            authMethod={authMethod}
            onAuthMethodChange={handleAuthMethodChange}
            githubAppConfigId={githubAppConfigId}
            onGithubAppConfigIdChange={setGithubAppConfigId}
            githubAppConfigs={githubAppConfigs}
            authLabel="Authentication"
            authOptional
            configuredDescription={
              <>
                Mints a short-lived installation token for this import. Manage
                configurations in
              </>
            }
            patFields={
              <>
                <SecretInput
                  id="skill-token"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_…"
                />
                <p className="text-sm text-muted-foreground">
                  Required for private repositories. Used only for this import
                  and never stored.{" "}
                  <a
                    href="https://github.com/settings/personal-access-tokens/new"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Create a token
                  </a>
                  .
                </p>
              </>
            }
          />
          <SkillScopeSelector
            scope={scope}
            onScopeChange={setScope}
            teamIds={teamIds}
            onTeamIdsChange={setTeamIds}
          />
          {discoverError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Couldn’t reach that repository</AlertTitle>
              <AlertDescription>
                <p>{discoverError}</p>
                {!hasGithubAuth && (
                  <p>
                    If the repository is private, add GitHub authentication
                    above and try again.
                  </p>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
      <SkillEditorDialog
        skillId={null}
        open={previewSkillPath !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setPreviewSkillPath(null);
        }}
        preview={previewData ?? null}
        isPreviewLoading={isPreviewLoading}
      />
    </StandardDialog>
  );
}
