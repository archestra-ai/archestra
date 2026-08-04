"use client";

import type { Permissions } from "@archestra/shared";
import { format } from "date-fns";
import { FileText, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type AgentListSection,
  type AgentSnapshotSection,
  type AgentTextSection,
  changedSections,
  compareAgentSnapshots,
} from "@/components/agent-version-diff";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DiffEditor } from "@/components/diff-editor";
import { Editor } from "@/components/editor";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfile } from "@/lib/agent.query";
import {
  type AgentVersionDetail,
  type AgentVersionSummary,
  useAgentVersion,
  useAgentVersions,
  useRestoreAgentVersion,
} from "@/lib/agent-version.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

/**
 * What the pane reads: the whole version, or only the sections that moved. The
 * mode picks the rendering too — the whole version reads as settings, a change
 * set reads as comparisons — so a changed section can be read either way.
 */
type VersionViewMode = "all" | "changes";

/** How the surrounding page names the entity; the copy follows it. */
const NOUN_BY_AGENT_TYPE: Record<string, string> = {
  agent: "agent",
  profile: "profile",
  mcp_gateway: "MCP gateway",
  llm_proxy: "LLM proxy",
};

/**
 * Restoring is an update to the entity, and each agent type carries its own
 * update permission — the same resource the page's edit button checks.
 */
const RESTORE_PERMISSIONS_BY_AGENT_TYPE: Record<string, Permissions> = {
  agent: { agent: ["update"] },
  profile: { agent: ["update"] },
  mcp_gateway: { mcpGateway: ["update"] },
  llm_proxy: { llmProxy: ["update"] },
};

/**
 * Browse an agent's immutable config version history and restore an earlier
 * one. Works for every agent type — internal agents, MCP gateways, LLM
 * proxies — since they are one entity with one version stream. A restore
 * replays the snapshot server-side and forks it forward as a new head
 * version, so the history is never rewritten.
 */
export function AgentVersionHistoryDialog(props: {
  agentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Remounting per agent drops the previewed version, which belongs to the
  // agent it was chosen for.
  return <VersionHistory key={props.agentId} {...props} />;
}

function VersionHistory({
  agentId,
  open,
  onOpenChange,
}: {
  agentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const {
    data: agent,
    isPending: isAgentLoading,
    refetch: refetchAgent,
  } = useProfile(open ? (agentId ?? undefined) : undefined);
  const versionsQuery = useAgentVersions(open ? agentId : null);

  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // Survives version selection: whoever came to read diffs keeps reading diffs.
  const [viewMode, setViewMode] = useState<VersionViewMode>("all");
  const [confirmingRestore, setConfirmingRestore] = useState(false);

  // Pages are read by offset from a list that grows at the head, so a version
  // created between two page loads shifts every row down and the next page
  // re-returns rows the previous one already held. Keyed by id, the second
  // copy is dropped instead of rendering the version twice.
  const versions = useMemo(() => {
    const seen = new Set<string>();
    return (versionsQuery.data?.pages ?? []).flatMap((page) =>
      (page?.data ?? []).filter((version) => {
        if (seen.has(version.id)) return false;
        seen.add(version.id);
        return true;
      }),
    );
  }, [versionsQuery.data]);
  // The freshly-fetched timeline outranks the profile: `useProfile` serves a
  // minutes-stale cache, and a lagging `latestVersion` would strip the true
  // newest row of its "Current" badge and offer to "restore" the actual head.
  const headVersion = versions[0]?.version ?? agent?.latestVersion ?? null;
  const activeVersion = selectedVersion ?? headVersion;
  const isHead = activeVersion !== null && activeVersion === headVersion;

  const {
    data: detail,
    isPending: isDetailLoading,
    isError: isDetailUnavailable,
    refetch: refetchDetail,
  } = useAgentVersion(open ? agentId : null, activeVersion);
  // Versions are contiguous, so the diff baseline is simply the previous
  // number — which retention may have pruned. One rule for the rest: a version
  // is compared against its predecessor when that predecessor loads, and shown
  // on its own when it does not.
  const hasPredecessor = activeVersion !== null && activeVersion > 1;
  const predecessorQuery = useAgentVersion(
    open ? agentId : null,
    hasPredecessor ? (activeVersion as number) - 1 : null,
  );
  const predecessor = predecessorQuery.data ?? null;
  const baselineFailed = hasPredecessor && predecessorQuery.isError;

  // What a restore would do to the agent *as it stands today* — a different
  // question from what this version changed, and the one the confirmation has
  // to answer. The head snapshot is fetched for that comparison; it is cached
  // and immutable, so viewing the head itself costs nothing extra.
  const headQuery = useAgentVersion(open ? agentId : null, headVersion);
  const restoreChanges = useMemo(() => {
    if (!detail || !headQuery.data || isHead) return [];
    return changedSections(
      compareAgentSnapshots(detail.snapshot, headQuery.data.snapshot),
    );
  }, [detail, headQuery.data, isHead]);

  const noun = NOUN_BY_AGENT_TYPE[agent?.agentType ?? "agent"] ?? "agent";
  const isBuiltIn = Boolean(agent?.builtIn);
  const canRestore = !!detail && !!agent && !isHead && !isBuiltIn;

  const restoreVersion = useRestoreAgentVersion();
  const handleRestore = async () => {
    if (!agentId || activeVersion === null || headVersion === null) return;
    // A handled failure resolves to null and a transport failure rejects; both
    // keep the confirmation open, so the toast explaining why still has the
    // dialog it refers to on screen.
    const result = await restoreVersion
      .mutateAsync({
        agentId,
        version: activeVersion,
        expectedHeadVersion: headVersion,
      })
      .catch(() => null);
    if (!result) return;
    setConfirmingRestore(false);
    // A restore lands as the new head, so the previewed version is no longer
    // what the agent looks like — jump the selection to the version just made.
    setSelectedVersion(result.agent.latestVersion);
  };

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Version history"
      description={
        agent
          ? `Every configuration change to "${agent.name}" is kept as a version. Restoring one adds a new version.`
          : `Every configuration change to a ${noun} is kept as a version.`
      }
      size="large"
      bodyClassName="flex flex-col overflow-hidden p-0"
      footer={
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          <PermissionButton
            permissions={
              RESTORE_PERMISSIONS_BY_AGENT_TYPE[agent?.agentType ?? "agent"] ??
              RESTORE_PERMISSIONS_BY_AGENT_TYPE.agent
            }
            disabled={!canRestore}
            onClick={() => setConfirmingRestore(true)}
            tooltip={restoreTooltip({ isHead, isBuiltIn, noun })}
          >
            Restore this version
          </PermissionButton>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Versions"
          className="w-48 shrink-0 overflow-y-auto border-r py-2"
        >
          <VersionTimeline
            versions={versions}
            headVersion={headVersion}
            activeVersion={activeVersion}
            isLoading={versionsQuery.isPending || isAgentLoading}
            isError={versionsQuery.isError}
            onRetry={() => versionsQuery.refetch()}
            hasMore={!!versionsQuery.hasNextPage}
            isLoadingMore={versionsQuery.isFetchingNextPage}
            onLoadMore={() => versionsQuery.fetchNextPage()}
            onSelect={setSelectedVersion}
          />
        </nav>

        <section className="flex min-w-0 flex-1 flex-col">
          {activeVersion === null ? (
            isAgentLoading || versionsQuery.isPending ? (
              <p className="p-6 text-sm text-muted-foreground">
                Loading version...
              </p>
            ) : (
              <LoadFailure
                message={`Could not load this ${noun}.`}
                onRetry={() => {
                  refetchAgent();
                  versionsQuery.refetch();
                }}
              />
            )
          ) : (
            <VersionPreview
              version={activeVersion}
              isHead={isHead}
              detail={detail ?? null}
              predecessor={predecessor}
              baselineFailed={baselineFailed}
              onRetryBaseline={() => predecessorQuery.refetch()}
              isLoading={isDetailLoading}
              isUnavailable={isDetailUnavailable}
              onRetry={() => refetchDetail()}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
            />
          )}
        </section>
      </div>

      {agent && detail && activeVersion !== null ? (
        <DeleteConfirmDialog
          open={confirmingRestore}
          onOpenChange={setConfirmingRestore}
          title={`Restore version ${activeVersion}?`}
          description={restoreEffects({
            version: activeVersion,
            noun,
            changes: restoreChanges,
          })}
          isPending={restoreVersion.isPending}
          onConfirm={handleRestore}
          // A restore only ever appends to the history, so it does not get the
          // red a delete confirmation uses.
          confirmVariant="default"
          confirmLabel={`Restore version ${activeVersion}`}
          pendingLabel="Restoring..."
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
  isError,
  onRetry,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onSelect,
}: {
  versions: AgentVersionSummary[];
  headVersion: number | null;
  activeVersion: number | null;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
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
  if (isError && versions.length === 0) {
    return (
      <LoadFailure
        message="Could not load the version history."
        onRetry={onRetry}
      />
    );
  }
  // Unlike skills, an agent created before versioning shipped genuinely has no
  // versions until its next config write, so an empty history is a real state.
  if (versions.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        No versions yet. The next configuration change records one.
      </p>
    );
  }

  return (
    <>
      {groupByDay(versions).map((group) => (
        <div key={group.label}>
          <h3 className="sticky top-0 bg-background px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h3>
          {group.versions.map((version) => {
            const isActive = version.version === activeVersion;
            return (
              <button
                key={version.id}
                type="button"
                aria-current={isActive ? "true" : undefined}
                onClick={() => onSelect(version.version)}
                className={cn(
                  "block w-full cursor-pointer border-l-2 border-transparent px-3 py-2 text-left hover:bg-muted",
                  isActive && "border-l-primary bg-accent",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-xs font-medium">
                    v{version.version}
                  </span>
                  {version.version === headVersion ? (
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                      Current
                    </Badge>
                  ) : null}
                  <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
                    {version.contentHash.slice(0, 7)}
                  </span>
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

/**
 * A read that failed, offered with a way to try again — kept distinct from
 * "no such version": a transport failure supports no claim about the history.
 */
function LoadFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-3 py-3">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * One version, read either way: the whole configuration as sections, or only
 * what moved as a set of comparisons.
 */
function VersionPreview({
  version,
  isHead,
  detail,
  predecessor,
  baselineFailed,
  onRetryBaseline,
  isLoading,
  isUnavailable,
  onRetry,
  viewMode,
  onViewModeChange,
}: {
  version: number;
  isHead: boolean;
  detail: AgentVersionDetail | null;
  predecessor: AgentVersionDetail | null;
  /** A baseline was expected and the read failed. */
  baselineFailed: boolean;
  onRetryBaseline: () => void;
  isLoading: boolean;
  /** This version itself could not be read — distinct from it not existing. */
  isUnavailable: boolean;
  onRetry: () => void;
  viewMode: VersionViewMode;
  onViewModeChange: (mode: VersionViewMode) => void;
}) {
  const sections = useMemo(
    () =>
      detail
        ? compareAgentSnapshots(detail.snapshot, predecessor?.snapshot ?? null)
        : [],
    [detail, predecessor],
  );

  if (isLoading && !detail) {
    return (
      <p className="p-6 text-sm text-muted-foreground">Loading version...</p>
    );
  }
  // A 404 is the only reading that supports "no longer available": retention
  // pruned the version. A failed read supports nothing about the history.
  if (!detail) {
    return isUnavailable ? (
      <LoadFailure
        message={`Version ${version} could not be loaded.`}
        onRetry={onRetry}
      />
    ) : (
      <p className="p-6 text-sm text-muted-foreground">
        This version is no longer available.
      </p>
    );
  }

  // Comparing takes a baseline, so a version without one stays on the whole
  // configuration however the switcher was left on the version before it.
  const mode: VersionViewMode = predecessor ? viewMode : "all";

  // "All settings" is the version itself, so a section it does not carry — a
  // hook it removed, a collection it emptied — has no row there. "Changes" is
  // what moved, which is exactly where those belong.
  const heldSections = sections.filter((section) => sectionIsHeld(section));
  const movedSections = changedSections(sections);
  const entries = mode === "all" ? heldSections : movedSections;

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
      {baselineFailed ? (
        <LoadFailure
          message={`Version ${version - 1} could not be loaded, so this version is shown on its own.`}
          onRetry={onRetryBaseline}
        />
      ) : null}
      <div className="px-4 pt-3">
        <ViewModeSwitcher
          mode={mode}
          onChange={onViewModeChange}
          sectionCount={heldSections.length}
          changeCount={movedSections.length}
          unavailableReason={
            predecessor
              ? null
              : compareUnavailableReason(version, baselineFailed)
          }
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing changed in this version.
          </p>
        ) : (
          <SectionBlocks entries={entries} mode={mode} />
        )}
      </div>
    </>
  );
}

/** Whether the viewed version itself carries the section's content. */
function sectionIsHeld(section: AgentSnapshotSection): boolean {
  switch (section.kind) {
    case "fields":
      return true;
    case "text":
      return section.current !== null;
    case "list":
      return section.items.some((item) => item.change !== "removed");
  }
}

/**
 * Read the whole version, or only what moved. "Changes" needs a predecessor
 * to compare against, so a version without one offers the reason instead.
 */
function ViewModeSwitcher({
  mode,
  onChange,
  sectionCount,
  changeCount,
  unavailableReason,
}: {
  mode: VersionViewMode;
  onChange: (mode: VersionViewMode) => void;
  sectionCount: number;
  changeCount: number;
  unavailableReason: string | null;
}) {
  return (
    <ButtonGroup>
      <Button
        type="button"
        size="sm"
        variant={mode === "all" ? "secondary" : "outline"}
        onClick={() => onChange("all")}
      >
        All settings ({sectionCount})
      </Button>
      {unavailableReason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button type="button" size="sm" variant="outline" disabled>
                Changes
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-60">
            {unavailableReason}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={mode === "changes" ? "secondary" : "outline"}
          onClick={() => onChange("changes")}
        >
          Changes ({changeCount})
        </Button>
      )}
    </ButtonGroup>
  );
}

/** Why this version cannot be compared — each reading is a different fact. */
function compareUnavailableReason(
  version: number,
  baselineFailed: boolean,
): string {
  if (version <= 1) {
    return "This is the earliest version, so there is nothing to compare it against.";
  }
  if (baselineFailed) {
    return `Version ${version - 1} could not be loaded, so there is nothing to compare against.`;
  }
  return `Loading version ${version - 1}...`;
}

/**
 * The version's sections stacked in one reading — root sections first, then
 * grouped ones (hooks) under their heading — each annotated with what changed.
 * There is no selection: scrolling is the navigation.
 */
function SectionBlocks({
  entries,
  mode,
}: {
  entries: AgentSnapshotSection[];
  mode: VersionViewMode;
}) {
  const rootEntries = entries.filter(
    (section) => section.kind !== "text" || section.group === null,
  );
  const groups = new Map<string, AgentTextSection[]>();
  for (const section of entries) {
    if (section.kind !== "text" || section.group === null) continue;
    const list = groups.get(section.group);
    if (list) {
      list.push(section);
    } else {
      groups.set(section.group, [section]);
    }
  }

  return (
    <div className="space-y-5">
      {rootEntries.map((section) => (
        <SectionBlock key={section.id} section={section} mode={mode} />
      ))}
      {[...groups.entries()].map(([group, sections]) => (
        <section key={group} aria-label={group}>
          <h3 className="pb-2 text-sm font-semibold">{group}</h3>
          <div className="space-y-4 border-l pl-3">
            {sections.map((section) => (
              <SectionBlock key={section.id} section={section} mode={mode} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SectionBlock({
  section,
  mode,
}: {
  section: AgentSnapshotSection;
  mode: VersionViewMode;
}) {
  const Icon = section.kind === "fields" ? Settings2 : FileText;
  return (
    <section aria-label={section.label}>
      <h3 className="flex items-center gap-2 pb-1.5">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{section.label}</span>
        <SectionChangeBadge section={section} />
      </h3>
      <div className="overflow-hidden rounded-md border">
        <SectionPane section={section} mode={mode} />
      </div>
    </section>
  );
}

/**
 * What moved in a section, at tree-row size. Collections get counts (+2 −1);
 * everything else gets the skills-style change word. `unchanged` and a null
 * change both go unbadged, for opposite reasons: one is a comparison that
 * found nothing, the other is no comparison at all.
 */
function SectionChangeBadge({ section }: { section: AgentSnapshotSection }) {
  if (section.change === null || section.change === "unchanged") return null;
  if (section.kind === "list") {
    return (
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {[
          section.addedCount > 0 ? `+${section.addedCount}` : null,
          section.removedCount > 0 ? `−${section.removedCount}` : null,
          section.changedCount > 0 ? `~${section.changedCount}` : null,
        ]
          .filter(Boolean)
          .join(" ")}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "shrink-0 text-[10px] font-semibold uppercase",
        section.change === "added" && "text-emerald-600 dark:text-emerald-400",
        section.change === "removed" && "text-destructive",
        section.change === "changed" && "text-muted-foreground",
      )}
    >
      {section.change}
    </span>
  );
}

/** Render the selected section by its kind and the view mode. */
function SectionPane({
  section,
  mode,
}: {
  section: AgentSnapshotSection;
  mode: VersionViewMode;
}) {
  switch (section.kind) {
    case "fields":
      return <FieldsPane section={section} mode={mode} />;
    case "list":
      return <ListPane section={section} mode={mode} />;
    case "text":
      return <TextPane section={section} mode={mode} />;
  }
}

function FieldsPane({
  section,
  mode,
}: {
  section: Extract<AgentSnapshotSection, { kind: "fields" }>;
  mode: VersionViewMode;
}) {
  const fields =
    mode === "changes"
      ? section.fields.filter((field) => field.change === "changed")
      : section.fields;
  if (fields.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">Nothing changed here.</p>
    );
  }
  return (
    <dl className="divide-y">
      {fields.map((field) => (
        <div
          key={field.label}
          className="grid grid-cols-[180px_1fr] gap-3 px-4 py-2 text-sm"
        >
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd className="min-w-0 break-words">
            {mode === "changes" ? (
              <>
                <span className="text-destructive line-through">
                  {field.previous ?? "Not set"}
                </span>
                <span className="mx-2 text-muted-foreground">→</span>
                <span className="text-emerald-600 dark:text-emerald-400">
                  {field.current ?? "Not set"}
                </span>
              </>
            ) : field.current !== null ? (
              <span>{field.current}</span>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ListPane({
  section,
  mode,
}: {
  section: AgentListSection;
  mode: VersionViewMode;
}) {
  // "All settings" reads the version itself, so a removed item only has a row
  // under "Changes" — the list of what moved.
  const items =
    mode === "changes"
      ? section.items.filter(
          (item) => item.change !== null && item.change !== "unchanged",
        )
      : section.items.filter((item) => item.change !== "removed");
  if (items.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {mode === "changes" ? "Nothing changed here." : "None."}
      </p>
    );
  }
  return (
    <ul className="divide-y">
      {items.map((item) => (
        <li key={item.key} className="flex flex-col gap-1 px-4 py-2 text-sm">
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate font-mono text-xs">
              {item.label}
            </span>
            {item.change === null || item.change === "unchanged" ? null : (
              <span
                className={cn(
                  "shrink-0 text-[10px] font-semibold uppercase",
                  item.change === "added" &&
                    "text-emerald-600 dark:text-emerald-400",
                  item.change === "removed" && "text-destructive",
                  item.change === "changed" && "text-muted-foreground",
                )}
              >
                {item.change}
              </span>
            )}
          </span>
          {/* A changed item's detail is the change, so both sides show. */}
          {item.change === "changed" && item.previousDetail !== item.detail ? (
            <span className="text-xs">
              <span className="text-destructive line-through">
                {item.previousDetail ?? "Not set"}
              </span>
              <span className="mx-2 text-muted-foreground">→</span>
              <span className="text-emerald-600 dark:text-emerald-400">
                {item.detail ?? "Not set"}
              </span>
            </span>
          ) : (item.detail ?? item.previousDetail) ? (
            <span className="text-xs text-muted-foreground">
              {item.detail ?? item.previousDetail}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TextPane({
  section,
  mode,
}: {
  section: AgentTextSection;
  mode: VersionViewMode;
}) {
  const metaFields =
    mode === "changes"
      ? section.fields.filter((field) => field.change === "changed")
      : section.fields;
  const asDiff = mode === "changes";
  // Stacked in one scroll pane, an editor has no parent height to fill — it is
  // sized to its content instead, capped so one long prompt does not swallow
  // the page (past the cap the editor scrolls internally).
  const editorHeight = textEditorHeight(
    section.current,
    asDiff ? section.previous : null,
  );
  return (
    <div className="flex flex-col">
      {metaFields.length > 0 ? (
        <dl className="divide-y border-b">
          {metaFields.map((field) => (
            <div
              key={field.label}
              className="grid grid-cols-[120px_1fr] gap-3 px-4 py-1.5 text-xs"
            >
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="min-w-0 break-words">
                {mode === "changes" ? (
                  <>
                    <span className="text-destructive line-through">
                      {field.previous ?? "Not set"}
                    </span>
                    <span className="mx-2 text-muted-foreground">→</span>
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {field.current ?? "Not set"}
                    </span>
                  </>
                ) : field.current !== null ? (
                  <span>{field.current}</span>
                ) : (
                  <span className="text-muted-foreground">Not set</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {asDiff ? (
        <DiffEditor
          height={editorHeight}
          language={section.language}
          original={section.previous ?? ""}
          modified={section.current ?? ""}
          options={{
            // A unified diff fits this dialog's narrow preview pane.
            renderSideBySide: false,
            // Long, mostly-unchanged bodies collapse to the edited regions.
            hideUnchangedRegions: { enabled: true },
          }}
        />
      ) : section.current !== null ? (
        <Editor
          height={editorHeight}
          language={section.language}
          value={section.current}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
          }}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">Not set.</p>
      )}
    </div>
  );
}

/**
 * A content-sized editor height in pixels: the longer side's line count at
 * Monaco's default line height plus a little padding, clamped so a one-liner
 * still reads as a text block and a long prompt does not take the whole page.
 */
function textEditorHeight(
  current: string | null,
  previous: string | null,
): number {
  const lineCount = Math.max(
    (current ?? "").split("\n").length,
    (previous ?? "").split("\n").length,
  );
  return Math.min(Math.max(lineCount * 19 + 24, 96), 400);
}

/**
 * What a restore would do to the agent as it stands today — the one thing a
 * confirmation has to answer. Named by section so the reader knows whether it
 * is the prompt, the tools, or the whole configuration that moves back.
 */
function restoreEffects({
  version,
  noun,
  changes,
}: {
  version: number;
  noun: string;
  changes: AgentSnapshotSection[];
}): string {
  const base = `Version ${version}'s configuration becomes the ${noun}'s configuration, as a new version.`;
  const summary =
    changes.length > 0
      ? ` This changes: ${changes.map(describeChange).join(", ")}.`
      : "";
  // Snapshots reference tools, models, and keys by id; anything deleted since
  // this version cannot be re-created by a restore and would be skipped.
  const caveat =
    " References to items deleted since then (tools, models, keys) are skipped.";
  return `${base}${summary}${caveat}`;
}

function describeChange(section: AgentSnapshotSection): string {
  if (section.kind === "list") {
    const counts = [
      section.addedCount > 0 ? `+${section.addedCount}` : null,
      section.removedCount > 0 ? `−${section.removedCount}` : null,
      section.changedCount > 0 ? `~${section.changedCount}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return counts ? `${section.label} (${counts})` : section.label;
  }
  return section.label;
}

function restoreTooltip({
  isHead,
  isBuiltIn,
  noun,
}: {
  isHead: boolean;
  isBuiltIn: boolean;
  noun: string;
}): string | undefined {
  if (isBuiltIn) return `Built-in ${noun}s cannot be modified.`;
  if (isHead) return `This is the ${noun}'s current configuration.`;
  return undefined;
}

function groupByDay(versions: AgentVersionSummary[]) {
  const groups: { label: string; versions: AgentVersionSummary[] }[] = [];
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
