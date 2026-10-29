"use client";

import type { Permissions } from "@archestra/shared";
import { type ReactNode, useMemo, useState } from "react";
import {
  type AgentSnapshotSection,
  changedSections,
  compareAgentSnapshots,
} from "@/components/agent-version-diff";
import {
  AgentVersionSections,
  summarizeAgentChanges,
} from "@/components/agent-version-sections";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { CommitGraphRail } from "@/components/version-history/commit-graph-rail";
import {
  CommitHeader,
  RestoreButton,
  UnreadVersionHeader,
} from "@/components/version-history/commit-header";
import {
  DiffSummaryStrip,
  type VersionViewMode,
} from "@/components/version-history/diff-summary-strip";
import { HunkScrollArea } from "@/components/version-history/hunk-block";
import { LoadFailure } from "@/components/version-history/load-failure";
import {
  EmptyHistory,
  NothingToDiff,
  PaneMessage,
  PaneSkeleton,
} from "@/components/version-history/pane-states";
import { VersionHistoryStatusLine } from "@/components/version-history/status-line";
import { useVersionHistoryShortcuts } from "@/components/version-history/use-version-history-shortcuts";
import {
  VersionHistoryShell,
  VersionHistorySubtitle,
} from "@/components/version-history/version-history-shell";
import { useProfile } from "@/lib/agent.query";
import {
  type AgentVersionDetail,
  useAgentVersion,
  useAgentVersions,
  useRestoreAgentVersion,
} from "@/lib/agent-version.query";
import { useHasPermissions } from "@/lib/auth/auth.query";

/**
 * How the viewed version's snapshot stands: read, still coming, unreadable, or
 * pruned by retention. The last two are distinct facts — a failed read
 * supports no claim about whether the version still exists.
 */
type DetailState = "ready" | "loading" | "unavailable" | "pruned";

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
export function AgentVersionHistoryDialog({
  agentId,
  canModify,
  onOpenChange,
}: {
  /** The agent whose history to read; null closes the dialog. */
  agentId: string | null;
  /**
   * Whether the reader may modify *this* entity — the scope check the page's
   * own row buttons apply on top of RBAC: an org admin, a team admin of the
   * team it is scoped to, or the owner of a personal one. Restoring is an
   * update, so the button here has to answer to it as Edit and Delete do,
   * rather than offering a write the server will refuse.
   */
  canModify: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Remounting per agent drops the previewed version, which belongs to the
  // agent it was chosen for.
  return (
    <VersionHistory
      key={agentId}
      agentId={agentId}
      canModify={canModify}
      onOpenChange={onOpenChange}
    />
  );
}

function VersionHistory({
  agentId,
  canModify,
  onOpenChange,
}: {
  agentId: string | null;
  canModify: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Whether the dialog is open is the same fact as whether it has an agent to
  // read, so it is derived rather than tracked — and a null id disables every
  // query below on its own.
  const open = agentId !== null;
  const {
    data: agent,
    isPending: isAgentLoading,
    refetch: refetchAgent,
  } = useProfile(agentId ?? undefined);
  const versionsQuery = useAgentVersions(agentId);

  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // Opens on what moved, the way `git show` does, and survives version
  // selection: whoever came to read diffs keeps reading diffs. A version with
  // no baseline still reads whole, whatever this says.
  const [viewMode, setViewMode] = useState<VersionViewMode>("changes");
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const restoreVersion = useRestoreAgentVersion();
  // Set on a successful restore, not read off `restoreVersion.data`: that
  // mutation instance is shared for the dialog's whole session, and
  // react-query clears its `data` back to `undefined` the moment a *second*
  // `mutateAsync` call starts — before that call's own result lands. Reading
  // it directly would drop `restoredHead` back to null for the duration of
  // that second call, regressing `headVersion` to a still-stale
  // `reportedHead` and un-badging the version the first restore just made
  // current. Local state has no such reset.
  const [restoredHead, setRestoredHead] = useState<number | null>(null);

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
  // A `latestVersion` of 0 is the column default for a config that has never
  // recorded a version — not a head. Reading it as one would point the detail
  // query at version 0, which it refuses to fetch, and the pane would report
  // itself loading forever.
  const reportedHead =
    versions[0]?.version ??
    (agent && agent.latestVersion > 0 ? agent.latestVersion : null);
  // A restore lands a new head before the timeline invalidation it triggers
  // comes back, and for that window every read above is one version behind:
  // the superseded head would keep its "Current" badge and the footer would
  // offer to restore what the agent already is. A restore only ever appends,
  // so the version it just minted is a head until something reports a higher
  // one — which the refetch, and anyone else's concurrent edit, then does.
  const headVersion =
    reportedHead === null
      ? restoredHead
      : restoredHead === null
        ? reportedHead
        : Math.max(reportedHead, restoredHead);
  const activeVersion = selectedVersion ?? headVersion;

  const {
    data: detail,
    isPending: isDetailLoading,
    isFetching: isDetailFetching,
    isError: isDetailUnavailable,
    refetch: refetchDetail,
  } = useAgentVersion(agentId, activeVersion);
  // Which version the pane is actually showing. A selection keeps the previous
  // snapshot on screen until the next one lands, so the clicked version and
  // the rendered one disagree for the length of that read — and every claim
  // the pane makes, from the header down to what a restore would do, has to be
  // about the snapshot in front of the reader rather than the click.
  const previewedVersion = detail?.version ?? activeVersion;
  const isHead = previewedVersion !== null && previewedVersion === headVersion;
  // Versions are contiguous, so the diff baseline is simply the previous
  // number — which retention may have pruned. One rule for the rest: a version
  // is compared against its predecessor when that predecessor loads, and shown
  // on its own when it does not.
  const baselineVersion =
    previewedVersion !== null && previewedVersion > 1
      ? previewedVersion - 1
      : null;
  const hasPredecessor = baselineVersion !== null;
  const predecessorQuery = useAgentVersion(agentId, baselineVersion);
  // The baseline read carries the same lag as the one above, so a snapshot is
  // this version's baseline only when it is numerically its predecessor —
  // otherwise the pane would diff two unrelated versions until the two reads
  // line up.
  const predecessor =
    predecessorQuery.data?.version === baselineVersion
      ? predecessorQuery.data
      : null;
  const baselineFailed = hasPredecessor && predecessorQuery.isError;
  // A settled null is the hook's reading of a 404: retention pruned the
  // baseline. Nothing is loading and nothing failed, so neither state above
  // covers it — without this one, the switcher would claim to be loading a
  // version that will never arrive. A held-over snapshot has settled for the
  // version *before* this one, so it says nothing about this baseline.
  const baselinePruned =
    hasPredecessor &&
    predecessorQuery.isSuccess &&
    !predecessorQuery.isPlaceholderData &&
    predecessorQuery.data === null;

  const noun = NOUN_BY_AGENT_TYPE[agent?.agentType ?? "agent"] ?? "agent";
  const isBuiltIn = Boolean(agent?.builtIn);
  const canRestore = !!detail && !!agent && !isHead && !isBuiltIn && canModify;
  // The preview pane tells these four apart; the disabled button has to give
  // the same reading rather than greying out with nothing to say.
  const detailState: DetailState = detail
    ? "ready"
    : isDetailLoading
      ? "loading"
      : isDetailUnavailable
        ? "unavailable"
        : "pruned";

  const restorePermissions =
    RESTORE_PERMISSIONS_BY_AGENT_TYPE[agent?.agentType ?? "agent"] ??
    RESTORE_PERMISSIONS_BY_AGENT_TYPE.agent;
  // The restore button checks this itself; the `r` key has to answer to it too.
  const { data: hasRestorePermission } = useHasPermissions(
    restorePermissions,
    agentId ?? undefined,
  );
  // Comparing takes a baseline, so a version without one stays on the whole
  // configuration however the switcher was left on the version before it.
  const effectiveViewMode: VersionViewMode = predecessor ? viewMode : "all";
  const previewedHash =
    detail?.contentHash ??
    versions.find((version) => version.version === previewedVersion)
      ?.contentHash ??
    null;
  // The timeline settled empty: an agent created before versioning shipped
  // genuinely has no versions until its next config write.
  const isEmptyHistory =
    activeVersion === null && versionsQuery.isSuccess && versions.length === 0;

  const handleRestore = async () => {
    if (!agentId || !detail || headVersion === null) return;
    // A handled failure resolves to null and a transport failure rejects.
    const result = await restoreVersion
      .mutateAsync({
        agentId,
        version: detail.version,
        baseVersion: headVersion,
      })
      .catch(() => null);
    // Closed on every outcome, and the toast explaining a failure outlives the
    // confirmation it was raised from. That matters most for the conflict:
    // `onSettled` refetches the timeline, so a confirmation left open would
    // let the very same button succeed on a second click, against a head
    // silently swapped underneath it — compare-and-set degraded to "click
    // twice". Closing sends the reader back to a preview rendered against the
    // head that actually moved, which is what the toast asks them to do.
    setConfirmingRestore(false);
    if (!result) return;
    // A restore only ever appends, so this can only move the high-water mark
    // up — safe to set unconditionally rather than maxing against the state
    // setter's own previous value.
    setRestoredHead(result.latestVersion);
    // A restore lands as the new head, so the previewed version is no longer
    // what the agent looks like — jump the selection to the version just made.
    setSelectedVersion(result.latestVersion);
  };

  const shortcuts = useVersionHistoryShortcuts({
    enabled: !confirmingRestore,
    versions: versions.map((version) => version.version),
    // The selection, not the snapshot on screen: a second `j` before the
    // first one's read lands has to move on from where the first one went.
    activeVersion,
    headVersion,
    onSelectVersion: setSelectedVersion,
    hasMore: !!versionsQuery.hasNextPage,
    isLoadingMore: versionsQuery.isFetchingNextPage,
    onLoadMore: () => versionsQuery.fetchNextPage(),
    onToggleViewMode: predecessor
      ? () => setViewMode(effectiveViewMode === "changes" ? "all" : "changes")
      : undefined,
    hash: previewedHash,
    onRestore:
      canRestore && hasRestorePermission
        ? () => setConfirmingRestore(true)
        : undefined,
  });

  return (
    <VersionHistoryShell
      open={open}
      onOpenChange={onOpenChange}
      onKeyDown={shortcuts.onKeyDown}
      subtitle={
        <VersionHistorySubtitle
          name={agent?.name}
          versionCount={versions.length}
          hasMore={!!versionsQuery.hasNextPage}
          isLoading={versionsQuery.isPending}
          fallback={`Every configuration change to a ${noun} is kept as a version.`}
        />
      }
      emptyState={
        isEmptyHistory ? (
          <EmptyHistory>
            The next configuration change to this {noun} records the first
            version. Every change after that lands here.
          </EmptyHistory>
        ) : undefined
      }
      rail={
        <CommitGraphRail
          versions={versions}
          headVersion={headVersion}
          activeVersion={activeVersion}
          isActivePending={isDetailFetching}
          isLoading={versionsQuery.isPending || isAgentLoading}
          isError={versionsQuery.isError}
          errorMessage="Could not load the version history."
          onRetry={() => versionsQuery.refetch()}
          emptyMessage="No versions yet. The next configuration change records one."
          hasMore={!!versionsQuery.hasNextPage}
          isLoadingMore={versionsQuery.isFetchingNextPage}
          onLoadMore={() => versionsQuery.fetchNextPage()}
          onSelect={setSelectedVersion}
        />
      }
      pane={
        activeVersion === null ? (
          isAgentLoading || versionsQuery.isPending ? (
            <PaneSkeleton />
          ) : (
            <div className="p-6">
              <LoadFailure
                message={`Could not load this ${noun}.`}
                onRetry={() => {
                  refetchAgent();
                  versionsQuery.refetch();
                }}
              />
            </div>
          )
        ) : (
          <VersionPreview
            version={previewedVersion ?? activeVersion}
            isHead={isHead}
            detail={detail ?? null}
            isStale={isDetailFetching}
            predecessor={predecessor}
            baselineFailed={baselineFailed}
            baselinePruned={baselinePruned}
            onRetryBaseline={() => predecessorQuery.refetch()}
            isLoading={isDetailLoading}
            isUnavailable={isDetailUnavailable}
            onRetry={() => refetchDetail()}
            viewMode={effectiveViewMode}
            onViewModeChange={setViewMode}
            onSelectVersion={setSelectedVersion}
            restoreAction={
              <RestoreButton
                version={previewedVersion ?? activeVersion}
                permissions={restorePermissions}
                permissionScope={agentId ?? undefined}
                canRestore={canRestore}
                tooltip={restoreTooltip({
                  version: activeVersion,
                  isHead,
                  isBuiltIn,
                  canModify,
                  detailState,
                  noun,
                })}
                onClick={() => setConfirmingRestore(true)}
              />
            }
          />
        )
      }
      statusLine={
        <VersionHistoryStatusLine
          activeVersion={previewedVersion}
          headVersion={headVersion}
          isHead={isHead}
          hash={previewedHash}
          isBusy={isDetailFetching || (isDetailLoading && !detail)}
          notice={shortcuts.notice}
          reading={
            detail ? (effectiveViewMode === "changes" ? "diff" : "tree") : null
          }
          keys={{
            toggleView: !!predecessor,
            copyHash: !!previewedHash,
            restore: canRestore && !!hasRestorePermission,
          }}
        />
      }
    >
      {agent && detail ? (
        <DeleteConfirmDialog
          open={confirmingRestore}
          onOpenChange={setConfirmingRestore}
          title={`Restore version ${detail.version}?`}
          description={restoreEffects({ version: detail.version, noun })}
          isPending={restoreVersion.isPending}
          onConfirm={handleRestore}
          // A restore only ever appends to the history, so it does not get the
          // red a delete confirmation uses.
          confirmVariant="default"
          confirmLabel={`Restore version ${detail.version}`}
          pendingLabel="Restoring..."
        />
      ) : null}
    </VersionHistoryShell>
  );
}

/**
 * One version, read either way: the whole configuration as hunks, or only
 * what moved as a set of comparisons under a `git diff --stat`.
 */
function VersionPreview({
  version,
  isHead,
  detail,
  isStale,
  predecessor,
  baselineFailed,
  baselinePruned,
  onRetryBaseline,
  isLoading,
  isUnavailable,
  onRetry,
  viewMode,
  onViewModeChange,
  onSelectVersion,
  restoreAction,
}: {
  version: number;
  isHead: boolean;
  detail: AgentVersionDetail | null;
  /** A newer selection is in flight; what is on screen is the version before. */
  isStale: boolean;
  predecessor: AgentVersionDetail | null;
  /** A baseline was expected and the read failed. */
  baselineFailed: boolean;
  /** A baseline was expected but retention pruned it; there is none to load. */
  baselinePruned: boolean;
  onRetryBaseline: () => void;
  isLoading: boolean;
  /** This version itself could not be read — distinct from it not existing. */
  isUnavailable: boolean;
  onRetry: () => void;
  /** Already settled against the baseline: "all" whenever there is none. */
  viewMode: VersionViewMode;
  onViewModeChange: (mode: VersionViewMode) => void;
  onSelectVersion: (version: number) => void;
  restoreAction: ReactNode;
}) {
  const sections = useMemo(
    () =>
      detail
        ? compareAgentSnapshots(detail.snapshot, predecessor?.snapshot ?? null)
        : [],
    [detail, predecessor],
  );
  // "All settings" is the version itself, so a section it does not carry — a
  // hook it removed, a collection it emptied — has no hunk there. "Changes" is
  // what moved, which is exactly where those belong.
  const heldSections = sections.filter((section) => sectionIsHeld(section));
  const movedSections = changedSections(sections);

  if (isLoading && !detail) return <PaneSkeleton />;
  // A 404 is the only reading that supports "no longer available": retention
  // pruned the version. A failed read supports nothing about the history.
  if (!detail) {
    return (
      <>
        <UnreadVersionHeader version={version} action={restoreAction} />
        {isUnavailable ? (
          <div className="p-6">
            <LoadFailure
              message={`Version ${version} could not be loaded.`}
              onRetry={onRetry}
            />
          </div>
        ) : (
          <PaneMessage>This version is no longer available.</PaneMessage>
        )}
      </>
    );
  }

  const entries = viewMode === "all" ? heldSections : movedSections;
  const summary = summarizeAgentChanges(movedSections);

  return (
    <>
      {isStale ? (
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 z-20 h-0.5 animate-pulse bg-primary/70 motion-reduce:animate-none"
        />
      ) : null}
      <CommitHeader
        version={detail.version}
        isHead={isHead}
        hash={detail.contentHash}
        parentHash={predecessor?.contentHash ?? null}
        onSelectParent={onSelectVersion}
        createdAt={detail.createdAt}
        action={restoreAction}
      />
      <DiffSummaryStrip
        version={detail.version}
        unavailableReason={
          predecessor
            ? null
            : compareUnavailableReason({
                version: detail.version,
                baselineFailed,
                baselinePruned,
              })
        }
        baselineFailed={baselineFailed}
        onRetryBaseline={onRetryBaseline}
        added={summary.added}
        removed={summary.removed}
        phrases={summary.phrases}
        changeCount={movedSections.length}
        heldCount={heldSections.length}
        allLabel="All settings"
        mode={viewMode}
        onModeChange={onViewModeChange}
      />
      <HunkScrollArea isStale={isStale}>
        {entries.length === 0 ? (
          <NothingToDiff>
            Version {detail.version} holds the same configuration as version{" "}
            {detail.version - 1}.
          </NothingToDiff>
        ) : (
          <AgentVersionSections
            // Remounting per version and reading resets every hunk's fold.
            key={`${detail.version}-${viewMode}`}
            entries={entries}
            mode={viewMode}
          />
        )}
      </HunkScrollArea>
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

/** Why this version cannot be compared — each reading is a different fact. */
function compareUnavailableReason({
  version,
  baselineFailed,
  baselinePruned,
}: {
  version: number;
  baselineFailed: boolean;
  baselinePruned: boolean;
}): string {
  if (version <= 1) {
    return "This is the earliest version, so there is nothing to compare it against.";
  }
  if (baselineFailed) {
    return `Version ${version - 1} could not be loaded, so there is nothing to compare against.`;
  }
  if (baselinePruned) {
    return `Version ${version - 1} is no longer available, so there is nothing to compare against.`;
  }
  return `Loading version ${version - 1}...`;
}

/**
 * What a restore does, stated rather than predicted. It deliberately makes no
 * claim about how the result differs from the configuration in place today:
 * answering that needs a comparison covering the whole snapshot, and a
 * confirmation that gets it wrong talks a reader through a whole-configuration
 * rewrite as though it were a no-op. The pane behind it already shows what
 * this version holds, and a restore that turns out to change nothing is
 * reported as such once it lands.
 */
function restoreEffects({
  version,
  noun,
}: {
  version: number;
  noun: string;
}): string {
  // Snapshots reference tools, models, and keys by id, and a restore is
  // all-or-nothing: one referent deleted since this version refuses the whole
  // thing rather than quietly restoring a partial configuration.
  return (
    `Version ${version}'s configuration becomes the ${noun}'s configuration, as a new version.` +
    ` If this version references anything deleted since — a tool, a model, a key — the restore is refused and the ${noun} is left as it is.`
  );
}

/**
 * Why the restore button is disabled, in the same reading the preview pane
 * gives — a version that could not be read and a version that no longer exists
 * disable it just as surely as the head does, and used to do so in silence.
 */
function restoreTooltip({
  version,
  isHead,
  isBuiltIn,
  canModify,
  detailState,
  noun,
}: {
  version: number | null;
  isHead: boolean;
  isBuiltIn: boolean;
  canModify: boolean;
  detailState: DetailState;
  noun: string;
}): string | undefined {
  // Singular: the nouns are display names, and `${noun}s` pluralizes "LLM
  // proxy" to "LLM proxys".
  if (isBuiltIn) return `This built-in ${noun} cannot be modified.`;
  if (!canModify) return `You do not have permission to modify this ${noun}.`;
  if (isHead) return `This is the ${noun}'s current configuration.`;
  if (detailState === "ready" || version === null) return undefined;
  switch (detailState) {
    case "loading":
      return `Loading version ${version}...`;
    case "unavailable":
      return `Version ${version} could not be loaded, so there is nothing to restore.`;
    case "pruned":
      return `Version ${version} is no longer available, so there is nothing to restore.`;
  }
}
