"use client";

import { format } from "date-fns";
import { RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DiffEditor } from "@/components/diff-editor";
import { Editor } from "@/components/editor";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type SkillVersionDetail,
  type SkillVersionSummary,
  useResetSkill,
  useRestoreSkillVersion,
  useSkill,
  useSkillVersion,
  useSkillVersions,
} from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { compareSkillVersionFiles } from "./skill-version-diff";

/**
 * Browse a skill's immutable version history and restore an earlier one.
 *
 * A version captures the skill's instructions and resource files, and nothing
 * else: frontmatter fields live in their own columns and are not versioned, so
 * neither the history nor a restore says anything about them.
 *
 * Restoring forks forward — the old bytes become a new head version — so the
 * history is only ever appended to, and a sandbox that pinned a version keeps
 * replaying the bytes it was activated with.
 */
export function SkillVersionHistoryDialog(props: {
  skillId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Remounting per skill drops the previewed version and file selection, which
  // belong to the skill they were chosen for and mean nothing for another one.
  return <VersionHistory key={props.skillId} {...props} />;
}

function VersionHistory({
  skillId,
  open,
  onOpenChange,
}: {
  skillId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const appName = useAppName();
  const { data: skill, isPending: isSkillLoading } = useSkill(
    open ? skillId : null,
  );
  const versionsQuery = useSkillVersions(open ? skillId : null);
  const restoreVersion = useRestoreSkillVersion();
  const resetSkill = useResetSkill();

  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // null = the SKILL.md body is being diffed; otherwise a resource file path.
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const versions = useMemo(
    () => versionsQuery.data?.pages.flatMap((page) => page?.data ?? []) ?? [],
    [versionsQuery.data],
  );
  const headVersion = skill?.latestVersion ?? versions[0]?.version ?? null;
  const activeVersion = selectedVersion ?? headVersion;
  const isHead = activeVersion !== null && activeVersion === headVersion;
  const headContentHash = versions.find(
    (version) => version.version === headVersion,
  )?.contentHash;

  const { data: detail, isPending: isDetailLoading } = useSkillVersion(
    open ? skillId : null,
    activeVersion,
  );
  // Versions are contiguous from 1, so the diff baseline is simply the previous
  // number; version 1 has none and renders as an all-new document.
  const { data: predecessor } = useSkillVersion(
    open ? skillId : null,
    activeVersion !== null && activeVersion > 1 ? activeVersion - 1 : null,
  );

  const comparedFiles = useMemo(
    () =>
      detail && predecessor
        ? compareSkillVersionFiles(detail.files, predecessor.files)
        : [],
    [detail, predecessor],
  );

  const isSynced = !!skill?.githubSyncInterval;
  const isBuiltIn = skill?.sourceType === "built_in";
  const canRestore =
    !!detail && !!skill && !isHead && !isSynced && !!headContentHash;

  const handleRestore = async () => {
    if (!skill || !detail || !headContentHash || activeVersion === null) return;
    const result = await restoreVersion.mutateAsync({
      skillId: skill.id,
      version: activeVersion,
      expectedHeadVersion: skill.latestVersion,
      headContentHash,
    });
    setConfirmingRestore(false);
    // A restore lands as the new head, so the previewed version is no longer
    // what the skill looks like — jump the selection to the version just made.
    if (result) setSelectedVersion(result.latestVersion);
  };

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Version history"
      description={
        skill
          ? `Every edit to "${skill.name}"'s instructions or resource files is kept as an immutable version. Restoring one creates a new version from it — nothing is overwritten.`
          : "Every edit to a skill's instructions or resource files is kept as an immutable version."
      }
      size="large"
      bodyClassName="flex flex-col overflow-hidden p-0"
      footer={
        <div className="flex w-full items-center gap-3">
          {isBuiltIn ? (
            <PermissionButton
              permissions={{ skill: ["update"] }}
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setConfirmingReset(true)}
              disabled={resetSkill.isPending}
            >
              <RotateCcw className="h-4 w-4" />
              <span>Reset to default</span>
            </PermissionButton>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <PermissionButton
              permissions={{ skill: ["update"] }}
              disabled={!canRestore || restoreVersion.isPending}
              onClick={() => setConfirmingRestore(true)}
              tooltip={restoreTooltip({ isSynced, isHead, appName })}
            >
              {restoreVersion.isPending
                ? "Restoring..."
                : "Restore this version"}
            </PermissionButton>
          </div>
        </div>
      }
    >
      {isSynced ? (
        <p className="border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          This skill&apos;s content is synced from GitHub. Earlier versions stay
          viewable, but restoring one is unavailable — stop syncing the skill in
          its editor to make it editable in {appName}.
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Versions"
          className="w-64 shrink-0 overflow-y-auto border-r py-2"
        >
          <VersionTimeline
            versions={versions}
            headVersion={headVersion}
            activeVersion={activeVersion}
            isLoading={versionsQuery.isPending || isSkillLoading}
            hasMore={!!versionsQuery.hasNextPage}
            isLoadingMore={versionsQuery.isFetchingNextPage}
            onLoadMore={() => versionsQuery.fetchNextPage()}
            onSelect={(version) => {
              setSelectedVersion(version);
              setActiveFilePath(null);
            }}
          />
        </nav>

        <section className="flex min-w-0 flex-1 flex-col">
          {activeVersion === null ? (
            <p className="p-6 text-sm text-muted-foreground">
              This skill has no recorded versions yet.
            </p>
          ) : (
            <VersionPreview
              version={activeVersion}
              isHead={isHead}
              detail={detail ?? null}
              predecessor={predecessor ?? null}
              isLoading={isDetailLoading}
              comparedFiles={comparedFiles}
              activeFilePath={activeFilePath}
              onSelectFile={setActiveFilePath}
            />
          )}
        </section>
      </div>

      {skill && detail && activeVersion !== null ? (
        <DeleteConfirmDialog
          open={confirmingRestore}
          onOpenChange={setConfirmingRestore}
          title={`Restore version ${activeVersion}?`}
          description={
            <RestoreEffects
              version={activeVersion}
              nextVersion={skill.latestVersion + 1}
              fileCount={detail.files.length}
            />
          }
          isPending={restoreVersion.isPending}
          onConfirm={handleRestore}
          confirmLabel={`Restore version ${activeVersion}`}
          pendingLabel="Restoring..."
        />
      ) : null}

      {skill ? (
        <DeleteConfirmDialog
          open={confirmingReset}
          onOpenChange={setConfirmingReset}
          title="Reset skill"
          description={`Reset "${skill.name}" to the version ${appName} ships? Any local edits to its instructions and resource files are overwritten, and the shipped content is recorded as a new version.`}
          isPending={resetSkill.isPending}
          onConfirm={async () => {
            const result = await resetSkill.mutateAsync(skill.id);
            if (result) {
              setConfirmingReset(false);
              setSelectedVersion(null);
            }
          }}
          confirmLabel="Reset to default"
          pendingLabel="Resetting..."
        />
      ) : null}
    </StandardDialog>
  );
}

function VersionTimeline({
  versions,
  headVersion,
  activeVersion,
  isLoading,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onSelect,
}: {
  versions: SkillVersionSummary[];
  headVersion: number | null;
  activeVersion: number | null;
  isLoading: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onSelect: (version: number) => void;
}) {
  if (isLoading && versions.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        Loading versions...
      </p>
    );
  }
  if (versions.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">No versions</p>
    );
  }

  return (
    <>
      {groupByDay(versions).map((group) => (
        <div key={group.label}>
          <h3 className="sticky top-0 bg-background px-4 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h3>
          {group.versions.map((version) => {
            const isActive = version.version === activeVersion;
            return (
              <button
                key={version.id}
                type="button"
                aria-current={isActive}
                onClick={() => onSelect(version.version)}
                className={cn(
                  "block w-full cursor-pointer border-l-2 border-transparent px-4 py-2 text-left hover:bg-muted",
                  isActive && "border-l-primary bg-accent",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs font-medium">
                    v{version.version}
                  </span>
                  {version.version === headVersion ? (
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                      Current
                    </Badge>
                  ) : null}
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {formatRelativeTimeFromNow(version.createdAt)}
                  </span>
                </span>
                <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                  {version.contentHash.slice(0, 7)}
                </span>
              </button>
            );
          })}
        </div>
      ))}
      {hasMore ? (
        <div className="px-4 pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            disabled={isLoadingMore}
            onClick={onLoadMore}
          >
            {isLoadingMore ? "Loading..." : "Load older versions"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function VersionPreview({
  version,
  isHead,
  detail,
  predecessor,
  isLoading,
  comparedFiles,
  activeFilePath,
  onSelectFile,
}: {
  version: number;
  isHead: boolean;
  detail: SkillVersionDetail | null;
  predecessor: SkillVersionDetail | null;
  isLoading: boolean;
  comparedFiles: ReturnType<
    typeof compareSkillVersionFiles<SkillVersionDetail["files"][number]>
  >;
  activeFilePath: string | null;
  onSelectFile: (path: string | null) => void;
}) {
  if (isLoading && !detail) {
    return (
      <p className="p-6 text-sm text-muted-foreground">Loading version...</p>
    );
  }
  if (!detail) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        This version is no longer available.
      </p>
    );
  }

  const activeFile =
    activeFilePath === null
      ? null
      : (comparedFiles.find((file) => file.path === activeFilePath) ?? null);
  const activeSnapshot = activeFile?.current ?? activeFile?.previous ?? null;
  const isBinary = activeSnapshot?.encoding === "base64";
  const changedFiles = comparedFiles.filter(
    (file) => file.change !== "unchanged",
  );
  const manifestChanged =
    !!predecessor && predecessor.content !== detail.content;
  const changeCount = changedFiles.length + (manifestChanged ? 1 : 0);

  return (
    <>
      <header className="flex items-baseline gap-2 px-4 pt-3">
        <h2 className="text-base font-semibold">Version {version}</h2>
        {isHead ? <Badge variant="outline">Current</Badge> : null}
        <span className="text-xs text-muted-foreground">
          {formatRelativeTimeFromNow(detail.createdAt)}
        </span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {detail.contentHash.slice(0, 7)}
        </span>
      </header>

      <Tabs
        defaultValue="changes"
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="mx-4 mt-2 w-fit">
          <TabsTrigger value="changes">
            Changes
            {changeCount > 0 ? (
              <span className="ml-1 text-muted-foreground">
                ({changeCount})
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="content">Instructions</TabsTrigger>
          <TabsTrigger value="files">Files ({detail.files.length})</TabsTrigger>
        </TabsList>

        <TabsContent
          value="changes"
          className="flex min-h-0 flex-1 flex-col gap-2 p-4"
        >
          {predecessor ? null : (
            <p className="text-xs text-muted-foreground">
              This is the earliest version available, so everything below reads
              as newly added.
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <FileChip
              label="Instructions"
              change={manifestChanged ? "changed" : "unchanged"}
              isActive={activeFilePath === null}
              onClick={() => onSelectFile(null)}
            />
            {changedFiles.map((file) => (
              <FileChip
                key={file.path}
                label={file.path}
                change={file.change}
                isActive={activeFilePath === file.path}
                onClick={() => onSelectFile(file.path)}
              />
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
            {isBinary ? (
              <p className="p-4 text-sm text-muted-foreground">
                This is a binary file — open the Files tab to see its metadata.
              </p>
            ) : (
              <DiffEditor
                height="100%"
                language={languageForPath(activeFile?.path ?? "SKILL.md")}
                original={
                  activeFile
                    ? (activeFile.previous?.content ?? "")
                    : (predecessor?.content ?? "")
                }
                modified={
                  activeFile
                    ? (activeFile.current?.content ?? "")
                    : detail.content
                }
              />
            )}
          </div>
        </TabsContent>

        <TabsContent value="content" className="min-h-0 flex-1 p-4">
          <div className="h-full overflow-hidden rounded-md border">
            <Editor
              height="100%"
              language="markdown"
              value={detail.content}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
              }}
            />
          </div>
        </TabsContent>

        <TabsContent
          value="files"
          className="min-h-0 flex-1 overflow-y-auto p-4"
        >
          {detail.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This version has no resource files.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {detail.files.map((file) => (
                <li
                  key={file.id}
                  className="flex items-center gap-3 px-3 py-2 text-sm"
                >
                  <span className="truncate font-mono text-xs">
                    {file.path}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {file.kind} · {file.encoding}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

function FileChip({
  label,
  change,
  isActive,
  onClick,
}: {
  label: string;
  change: "added" | "removed" | "changed" | "unchanged";
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs hover:bg-muted",
        isActive && "border-primary bg-accent",
      )}
    >
      <span className="truncate">{label}</span>
      {change === "unchanged" ? null : (
        <span
          className={cn(
            "text-[10px] font-semibold uppercase",
            change === "added" && "text-emerald-600 dark:text-emerald-400",
            change === "removed" && "text-destructive",
            change === "changed" && "text-muted-foreground",
          )}
        >
          {change}
        </span>
      )}
    </button>
  );
}

function RestoreEffects({
  version,
  nextVersion,
  fileCount,
}: {
  version: number;
  nextVersion: number;
  fileCount: number;
}) {
  return (
    <span className="block space-y-2">
      <span className="block">
        This creates version {nextVersion} from version {version}&apos;s
        content. Nothing in the history is rewritten or removed.
      </span>
      <span className="block">
        It replaces the skill&apos;s instructions and its {fileCount} resource
        {fileCount === 1 ? " file" : " files"}. Everything else is left as it
        is: the name, description, and other frontmatter fields are not
        versioned, and neither are scope, teams, environments, or GitHub
        settings.
      </span>
    </span>
  );
}

function groupByDay(versions: SkillVersionSummary[]) {
  const groups: { label: string; versions: SkillVersionSummary[] }[] = [];
  for (const version of versions) {
    const label = format(new Date(version.createdAt), "MMM d, yyyy");
    const current = groups.at(-1);
    if (current?.label === label) {
      current.versions.push(version);
    } else {
      groups.push({ label, versions: [version] });
    }
  }
  return groups;
}

function restoreTooltip({
  isSynced,
  isHead,
  appName,
}: {
  isSynced: boolean;
  isHead: boolean;
  appName: string;
}): string | undefined {
  if (isSynced) {
    return `This skill is synced from GitHub. Stop syncing it to edit and restore it in ${appName}.`;
  }
  if (isHead) return "This is the skill's current version.";
  return undefined;
}

function languageForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return LANGUAGES_BY_EXTENSION[extension] ?? "plaintext";
}

const LANGUAGES_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  sh: "shell",
  ts: "typescript",
  txt: "plaintext",
  yaml: "yaml",
  yml: "yaml",
};
