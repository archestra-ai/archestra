"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { useGithubAppConfigs } from "@/lib/github-app-config.query";
import { useCreateGithubPat, useGithubPats } from "@/lib/github-pat.query";
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
  const { data: githubPats = [] } = useGithubPats();
  const createPat = useCreateGithubPat();
  const appName = useAppName();

  const [repoUrl, setRepoUrl] = useState(initialRepoUrl);
  const [path, setPath] = useState("");
  const [authMethod, setAuthMethod] = useState<"pat" | "github_app">("pat");
  const [githubToken, setGithubToken] = useState("");
  // "" = paste a one-time token; otherwise the id of a saved token
  const [githubPatId, setGithubPatId] = useState("");
  const [githubAppConfigId, setGithubAppConfigId] = useState("");
  const [discovered, setDiscovered] = useState<SelectStepSkill[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [previewSkillPath, setPreviewSkillPath] = useState<string | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  // scope applies to every skill selected in this import
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  // pull schedule for every skill selected in this import: imports are
  // always synced from the repo and read-only here until disconnected.
  const [syncInterval, setSyncInterval] = useState<"15m" | "1h" | "1d">("1d");
  // name under which a newly pasted token is saved (Settings -> GitHub)
  const [newTokenName, setNewTokenName] = useState("");
  // subpath + authentication live behind this fold; opened automatically when
  // a discover failure looks like a missing-auth problem.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // auth methods are mutually exclusive; the backend rejects combinations
  const githubAuthFields =
    authMethod === "github_app"
      ? githubAppConfigId
        ? { githubAppConfigId }
        : {}
      : githubPatId
        ? { githubPatId }
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
    setGithubPatId("");
    setGithubAppConfigId("");
    setDiscovered(null);
    setSelected(new Set());
    setSearch("");
    setPreviewSkillPath(null);
    setDiscoverError(null);
    setScope("personal");
    setTeamIds([]);
    setSyncInterval("1d");
    setNewTokenName("");
    setAdvancedOpen(false);
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
    } else {
      setGithubPatId("");
      setGithubToken("");
      setNewTokenName("");
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
      // a private repo without credentials is the most common failure — put
      // the auth fields in front of the user
      if (!hasGithubAuth) setAdvancedOpen(true);
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
    // a pasted token is saved as a stored credential first, so the recurring
    // sync it backs stays authenticated (transient tokens are never stored)
    let patId = githubPatId;
    if (authMethod === "pat" && !patId && githubToken.trim()) {
      const created = await createPat.mutateAsync({
        name:
          newTokenName.trim() ||
          `${repoSlug?.split("/").pop() || "GitHub"} token`,
        token: githubToken.trim(),
      });
      if (!created) return;
      patId = created.id;
      setGithubPatId(created.id);
    }

    const result = await importSkills.mutateAsync({
      repoUrl,
      ...(path.trim() && { path: path.trim() }),
      ...(authMethod === "github_app"
        ? githubAppConfigId
          ? { githubAppConfigId }
          : {}
        : patId
          ? { githubPatId: patId }
          : {}),
      skillPaths: [...selected],
      scope,
      teamIds: scope === "team" ? teamIds : [],
      sync: { interval: syncInterval },
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
      : githubPatId.length > 0 || githubToken.trim().length > 0;

  // what the collapsed Advanced fold is configured with, e.g. "saved token, subpath"
  const advancedSummary = [
    authMethod === "github_app" && githubAppConfigId
      ? "GitHub App"
      : githubPatId
        ? "saved token"
        : githubToken.trim()
          ? "one-time token"
          : null,
    path.trim() ? "subpath" : null,
  ]
    .filter(Boolean)
    .join(", ");

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
                    <div className="flex items-center gap-2">
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
                          ? "Deselect all"
                          : search.trim()
                            ? `Select all (${selectableFiltered.length} visible)`
                            : "Select all"}
                      </label>
                    </div>
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
                              onCheckedChange={() => toggle(skill.skillPath)}
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
        <div className="space-y-5">
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
              Every directory with a <code className="font-mono">SKILL.md</code>{" "}
              becomes an importable skill.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-sync-interval">Keep in sync</Label>
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
            <p className="text-sm text-muted-foreground">
              Pulled from the repository on this schedule; read-only in{" "}
              {appName} until disconnected.
            </p>
          </div>
          <SkillScopeSelector
            scope={scope}
            onScopeChange={setScope}
            teamIds={teamIds}
            onTeamIdsChange={setTeamIds}
          />
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
              <ChevronRight
                className={cn(
                  "h-4 w-4 shrink-0 transition-transform",
                  advancedOpen && "rotate-90",
                )}
              />
              Authentication & subpath
              {!advancedOpen && advancedSummary && (
                <span className="font-normal text-xs">· {advancedSummary}</span>
              )}
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-5 pt-4">
              <GithubAuthConfigFields
                authMethod={authMethod}
                onAuthMethodChange={handleAuthMethodChange}
                githubAppConfigId={githubAppConfigId}
                onGithubAppConfigIdChange={setGithubAppConfigId}
                githubAppConfigs={githubAppConfigs}
                authLabel="Authentication"
                authOptional
                authDescription={null}
                configuredDescription={
                  <>
                    Mints a short-lived installation token for this import.
                    Manage configurations in
                  </>
                }
                patFields={
                  <>
                    {githubPats.length > 0 && (
                      <Select
                        value={githubPatId || "new"}
                        onValueChange={(value) => {
                          setGithubPatId(value === "new" ? "" : value);
                          if (value !== "new") {
                            setGithubToken("");
                            setNewTokenName("");
                          }
                        }}
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label="Saved token"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {githubPats.map((pat) => (
                            <SelectItem key={pat.id} value={pat.id}>
                              {pat.name}
                            </SelectItem>
                          ))}
                          <SelectItem value="new">New token…</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    {githubPatId ? (
                      <p className="text-sm text-muted-foreground">
                        Synced imports stay authenticated with this saved token.
                        Manage saved tokens in{" "}
                        <a
                          href="/settings/github"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          Settings → GitHub
                        </a>
                        .
                      </p>
                    ) : (
                      <>
                        <SecretInput
                          id="skill-token"
                          value={githubToken}
                          onChange={(e) => setGithubToken(e.target.value)}
                          placeholder="ghp_…"
                        />
                        {githubToken.trim() && (
                          <Input
                            value={newTokenName}
                            onChange={(e) => setNewTokenName(e.target.value)}
                            placeholder={`Token name — e.g. ${repoSlug || "skills repo"} token`}
                            aria-label="Token name"
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                          />
                        )}
                        <p className="text-sm text-muted-foreground">
                          Needed for private repositories. Saved to{" "}
                          <a
                            href="/settings/github"
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            Settings → GitHub
                          </a>{" "}
                          on import so scheduled syncs stay authenticated.{" "}
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
                    )}
                  </>
                }
              />
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
                  Scan only this directory of a large repository.
                </p>
              </div>
            </CollapsibleContent>
          </Collapsible>
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
