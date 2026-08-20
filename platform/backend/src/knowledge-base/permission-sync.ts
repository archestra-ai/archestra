// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { hostname } from "node:os";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { PERMISSION_SYNC_FULL_RECONCILE_INTERVAL_SECONDS } from "@archestra/shared";
import type pino from "pino";
import { z } from "zod";
import config from "@/config";
import defaultLogger from "@/logging";
import {
  ConnectorRunModel,
  KbContainerAclModel,
  KbDocumentModel,
  KbExternalGroupModel,
  KbExternalUserGroupModel,
  KbMemberOverrideModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import * as metrics from "@/observability/metrics";
import type {
  AclEntry,
  Connector,
  ConnectorCredentials,
  ConnectorIdentity,
  InsertKbContainerAcl,
  InsertKbExternalGroup,
  InsertKbExternalUserGroup,
  KnowledgeBaseConnector,
  PermissionProbeResult,
  PermissionSyncRunStats,
  PermissionSyncState,
  ReadIngestedDocuments,
  ResolveMappedEmail,
} from "@/types";
import { buildContainerToken, normalizeEmail } from "./acl-tokens";
import {
  resolveConnectorCredentials,
  resolveConnectorCredentialVersion,
} from "./connector-credentials";
import {
  BaseConnector,
  extractErrorMessage,
} from "./connectors/base-connector";
import { getConnector } from "./connectors/registry";
import { invalidateGroupTokenCache } from "./group-token-cache";
import { buildDocumentAccessControlList } from "./source-access-control";

const WORKER_ID = `${hostname()}#${process.pid}`;

// Batch size for the pass's ACL writes and its per-container fail-close
// set-diffs. Bounds per-transaction work so mass-change bursts stay in short
// transactions (bounded WAL/lock). Fixed like EMBEDDING_BATCH_SIZE — not an
// operator knob.
const PERMISSION_SYNC_BATCH_SIZE = 200;

/**
 * Resumable checkpoint for a permission-sync run. `cursor` is the last
 * COMPLETED top-level container key (the connector re-enumerates from it,
 * re-doing the in-flight container idempotently).
 *
 * Parsed, not cast, because it comes back from a `jsonb` column that older
 * releases wrote a different shape into (the retired generation-based
 * `{ phase: "documents" }` reconcile) and that nothing constrains at the
 * database. The cursor is compared against container keys with `<`, so a
 * non-string that survived into the pass would not throw — it would silently
 * skip or re-do containers. Anything that does not parse is treated as absent:
 * the pass starts a fresh full reconcile, which is always safe.
 */
const PermissionSyncCheckpointSchema = z.object({
  phase: z.literal("snapshot"),
  cursor: z.string().nullable(),
});
type PermissionSyncCheckpoint = z.infer<typeof PermissionSyncCheckpointSchema>;

/**
 * In-flight reconcile state for one top-level container: the upstream source
 * ids seen so far (the fail-close set-diff) and the assignments not yet
 * flushed to the database.
 */
type UnitState = {
  key: string;
  seen: Set<string>;
  pending: {
    sourceId: string;
    containerKey: string;
    exceptionUsers?: string[];
  }[];
};

/** One container's upstream audience, as a connector resolves it. */
type ContainerAudience = {
  containerKey: string;
  permissions: unknown;
  fingerprint: string | null;
  /** The connector could not READ the permissions — this is fail-closed, not observed. */
  audienceResolutionFailed: boolean;
};

/**
 * The single, connector-agnostic permission-sync pass for
 * `auto-sync-permissions` connectors. Runs in the runtime-isolated `permission`
 * job family (its own connector-run lease and queue lane). Each run reconciles
 * CONTAINER audiences (one `kb_container_acls` row per space/project/repo or
 * nested exception) and per-document container assignments: an upstream
 * audience change is one container-row write, document/chunk writes happen
 * only for adopted, reassigned, exception-changed, or vanished documents —
 * O(changed), never O(documents) — and never re-embed anything. Fail-close is
 * a per-container set-diff (documents present in our DB but absent from the
 * container's completed upstream enumeration), plus a completion-gated sweep
 * of containers that vanished upstream entirely.
 */
class PermissionSyncService {
  /**
   * ACL-write / fail-close batch size. Fixed in production
   * (PERMISSION_SYNC_BATCH_SIZE); tests shrink it to pin per-batch
   * checkpoint/partial behavior.
   */
  batchSize = PERMISSION_SYNC_BATCH_SIZE;

  async executePass(
    connectorId: string,
    options?: {
      logger?: pino.Logger;
      getLogOutput?: () => string;
      /** Force a full reconcile (manual "Sync Permissions Now"). */
      mode?: "full";
    },
  ): Promise<{ runId: string; status: string }> {
    const log = options?.logger ?? defaultLogger;

    const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
    if (!connector) {
      throw new Error(`Connector not found: ${connectorId}`);
    }

    if (connector.visibility !== "auto-sync-permissions") {
      log.debug(
        { connectorId, visibility: connector.visibility },
        "Connector is not auto-sync-permissions; skipping permission pass",
      );
      return { runId: "", status: "skipped" };
    }

    // Disabled means disabled, for permissions as much as for content. Stated
    // here rather than left to the scheduler: a task enqueued before the
    // connector was switched off still arrives afterwards, and a pass costs a
    // pod, a token and an egress rule against the customer's Perforce server.
    // Stored ACLs are untouched, so nothing is opened up by not running — the
    // audience simply stops being refreshed until the connector is re-enabled.
    if (!connector.enabled) {
      log.info(
        { connectorId },
        "Connector is disabled; skipping permission pass",
      );
      return { runId: "", status: "skipped" };
    }

    const connectorImpl = getConnector(connector.connectorType);
    if (
      !connectorImpl.supportsPermissionSync ||
      !connectorImpl.syncPermissionSnapshot
    ) {
      log.warn(
        { connectorId, connectorType: connector.connectorType },
        "Connector does not implement permission sync; skipping",
      );
      return { runId: "", status: "skipped" };
    }

    // Single-flight within the `permission` family (independent of content).
    const leaseTtlSeconds = config.kb.connectorRunLeaseTtlSeconds;
    const claim = await ConnectorRunModel.claim({
      connectorId,
      owner: WORKER_ID,
      leaseTtlSeconds,
      runType: "permission",
    });
    if (claim.outcome === "busy") {
      log.info(
        { connectorId },
        "A permission sync is already running for this connector; skipping",
      );
      return { runId: "", status: "skipped" };
    }

    const run = claim.run;
    const epoch = run.leaseEpoch;
    // `claim` always inserts a fresh run (no checkpoint). If the previous
    // terminal run of this family was interrupted (reaper-marked `partial`),
    // adopt its checkpoint so this run resumes from its container cursor
    // rather than restarting the reconcile.
    const adoptedCheckpoint =
      run.checkpoint ??
      (await ConnectorRunModel.findResumableCheckpoint({
        connectorId,
        runType: "permission",
        excludeRunId: run.id,
      }));
    const runLog = log.child({
      runId: run.id,
      connectorId,
      connectorType: connector.connectorType,
    });
    // Anything that is not this exact shape — a pre-container checkpoint from
    // the retired generation-based reconcile, or a corrupted row — resumes
    // nothing and the pass runs a fresh full reconcile.
    const parsedCheckpoint =
      PermissionSyncCheckpointSchema.safeParse(adoptedCheckpoint);
    const priorCheckpoint = parsedCheckpoint.success
      ? parsedCheckpoint.data
      : null;
    if (adoptedCheckpoint != null && !parsedCheckpoint.success) {
      runLog.warn(
        { checkpoint: adoptedCheckpoint },
        "Ignoring an unrecognized permission-sync checkpoint; running a full reconcile from the start",
      );
    }
    if (connectorImpl instanceof BaseConnector) {
      connectorImpl.setLogger(runLog);
    }

    const beat = () => {
      ConnectorRunModel.renewLease({
        runId: run.id,
        owner: WORKER_ID,
        epoch,
        leaseTtlSeconds,
      })
        .then((held) => {
          if (!held) runLog.warn("Permission run lease lost during heartbeat");
        })
        .catch((error) => {
          runLog.warn(
            { error: extractErrorMessage(error) },
            "Permission run heartbeat failed",
          );
        });
    };
    beat();
    const heartbeat = setInterval(
      beat,
      config.kb.connectorRunHeartbeatIntervalSeconds * 1000,
    );
    heartbeat.unref();

    try {
      const result = await this.runClaimedPass({
        connector,
        connectorImpl,
        runId: run.id,
        epoch,
        startedAt: run.startedAt,
        priorCheckpoint,
        runLog,
        getLogOutput: options?.getLogOutput,
        forceFull: options?.mode === "full",
      });
      // This pass is the only writer of group memberships, so drop the
      // per-user group-token cache whenever one finishes — including a
      // `partial` run, whose group phase may have completed before the
      // interruption. Freshly synced access is then visible on the next
      // query instead of after the cache TTL.
      await invalidateGroupTokenCache();
      return result;
    } catch (error) {
      // runClaimedPass converts mid-reconcile errors to a resumable `partial`
      // itself; an error escaping it means the pass died outside that handling
      // (e.g. marking the run running, or the partial bookkeeping failing).
      // Without this increment a complete failure is invisible in Prometheus.
      metrics.rag.reportPermissionSync({
        connectorType: connector.connectorType,
        status: "failed",
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  // ===== Private methods =====

  private async runClaimedPass(params: {
    connector: KnowledgeBaseConnector;
    connectorImpl: Connector;
    runId: string;
    epoch: number;
    startedAt: Date;
    priorCheckpoint: PermissionSyncCheckpoint | null;
    runLog: pino.Logger;
    getLogOutput?: () => string;
    forceFull: boolean;
  }): Promise<{ runId: string; status: string }> {
    const {
      connector,
      connectorImpl,
      runId,
      epoch,
      startedAt,
      priorCheckpoint,
      runLog,
      getLogOutput,
      forceFull,
    } = params;
    const connectorId = connector.id;
    // Epoch read alongside the visibility config; every ACL write is fenced on
    // it so a write computed against a now-stale config no-ops.
    const aclConfigEpoch = connector.aclConfigEpoch;

    await KnowledgeBaseConnectorModel.update(connectorId, {
      lastPermissionSyncStatus: "running",
      lastPermissionSyncAt: startedAt,
    });

    // Whether this run completed at least one snapshot unit BEYOND its resume
    // cursor. The catch below finalizes a progressed run as `partial` (a
    // re-enqueued resume picks up real work) and a zero-progress run as
    // `failed` (a deterministic error — e.g. an upstream 400 — would just
    // re-fail in a hot re-enqueue loop until the resume-budget breaker trips;
    // the scheduled cadence is the retry path instead).
    let snapshotProgressed = false;

    // Ownership, as the write paths take it: every access-granting write in
    // this pass carries it, so a pass whose run was reclaimed cannot land one
    // even if it never notices it lost the lease.
    const fence = { runId, epoch };

    try {
      const credentials = await resolveConnectorCredentials(connector, {
        // Perforce alone provisions a runtime from these credentials: the pass
        // rotates the shim's pod whenever the stored password changes, and a
        // cached read on this replica would hand the fresh pod the password it
        // just retired. Every other connector authenticates upstream directly,
        // where a stale read costs one failed pass and no rotation.
        uncached: connector.connectorType === "perforce",
      });
      const identity = await connectorIdentity(connector, fence);
      // Read-back of already-ingested docs, injected into the hooks so
      // container-scoped connectors (GitHub) can tag a container's documents
      // without re-enumerating upstream. Keyset-paginated, O(page) memory.
      const readIngestedDocuments: ReadIngestedDocuments = async (args) => {
        const rows = await KbDocumentModel.findIngestedForReadback({
          connectorId,
          metadataFilter: args.metadataFilter,
          afterId: args.afterId,
          limit: args.limit,
        });
        return {
          documents: rows
            .filter((row): row is typeof row & { sourceId: string } =>
              Boolean(row.sourceId),
            )
            .map((row) => ({ sourceId: row.sourceId, metadata: row.metadata })),
          nextAfterId: rows.length > 0 ? rows[rows.length - 1].id : null,
        };
      };
      // Family-relevant run stats, persisted on the run row alongside each
      // checkpoint (live progress) and finalized on completion. The
      // content-sync counters stay 0 for permission runs; these are what the
      // Permission Sync Runs UI renders.
      const stats: PermissionSyncRunStats = {
        totalDocs: 0,
        docsScanned: 0,
        aclsChanged: 0,
        chunksRewritten: 0,
        failClosed: 0,
        groupsSynced: 0,
        membershipsUpserted: 0,
        containersSynced: 0,
        containersChanged: 0,
        docsAdopted: 0,
        docsReassigned: 0,
        // A pass overlapping a content backfill only covers what was ingested
        // when it enumerated; later-ingested docs stay fail-closed until the
        // next pass. Surfaced so a "success" during a backfill is legible.
        contentSyncActiveDuringRun: await ConnectorRunModel.hasRunningRun({
          connectorId,
          runType: "content",
        }),
      };

      // ---- Mode decision: probe-driven DELTA at the user-facing cadence,
      // FULL reconcile as the periodic backstop (vanished/unassigned sweeps
      // only run there). Full when: forced (manual sync), the connector has no
      // probe hook, an interrupted pass is being resumed (it must finish with
      // full semantics), the last full reconcile aged out, or the probe itself
      // says the change cannot be scoped. The probe runs on FULL passes too —
      // that is what establishes fresh cursors for the deltas that follow;
      // its state is persisted only on success, so an interrupted pass
      // re-probes from the same cursors. ----
      const previousState = (connector.permissionSyncState ??
        null) as PermissionSyncState | null;
      let probe: PermissionProbeResult | null = null;
      if (connectorImpl.probePermissionChanges) {
        try {
          probe = await connectorImpl.probePermissionChanges({
            config: connector.config as Record<string, unknown>,
            identity,
            credentials,
            state: previousState,
          });
        } catch (error) {
          runLog.warn(
            { error: extractErrorMessage(error) },
            "Permission change probe failed; falling back to a full reconcile",
          );
        }
      }
      const lastFullAt =
        typeof previousState?.lastFullReconcileAt === "string"
          ? Date.parse(previousState.lastFullReconcileAt)
          : Number.NaN;
      const fullDue =
        !Number.isFinite(lastFullAt) ||
        Date.now() - lastFullAt >=
          PERMISSION_SYNC_FULL_RECONCILE_INTERVAL_SECONDS * 1000;
      // Delta passes verify the exact scope returned by the probe. Sources with
      // an authoritative, gap-detecting journal may return only dirty objects
      // and groups; other probes keep the conservative all-container refresh.
      // A connector that can probe but cannot refresh audiences has no delta.
      const audienceRefreshUnsupported =
        !connectorImpl.refreshContainerAudiences;
      const mode: "full" | "delta" =
        probe &&
        !probe.fullRequired &&
        !audienceRefreshUnsupported &&
        !forceFull &&
        !fullDue &&
        !priorCheckpoint
          ? "delta"
          : "full";
      stats.mode = mode;
      // Only a MANUAL pass bypasses the cross-pass identity caches. Keying this
      // off `mode === "full"` instead made the caches dead weight for any
      // connector without a delta mode — GitHub has no probe and no audience
      // refresh, so every one of its passes is "full", and every pass re-fetched
      // the profile of every collaborator and team member. That is one
      // rate-limited API call per org member per pass, against a 5k/hour token
      // budget, on a 30-minute cadence. Scheduled passes now read the caches,
      // whose 24h TTL already bounds identity staleness to what a daily full
      // reconcile gave; an admin who needs an identity change picked up NOW
      // presses "Sync Permissions Now", which is what `forceFull` means.
      const refreshIdentities = forceFull;
      // A full promotion must be explainable from the logs alone — every
      // trigger of one is a legitimate question ("why did this pass re-scan
      // the whole corpus?") with six possible answers.
      runLog.info(
        mode === "full"
          ? {
              mode,
              fullBecause: {
                forced: forceFull,
                resumedCheckpoint: priorCheckpoint !== null,
                probeUnavailable: probe === null,
                probeFullRequired: probe?.fullRequired ?? false,
                audienceRefreshUnsupported,
                fullReconcileDue: fullDue,
              },
            }
          : {
              mode,
              dirtyContainers: probe?.dirtyContainerKeys.length ?? 0,
            },
        "Permission pass mode decided",
      );
      const nextSyncState = (): PermissionSyncState | null =>
        probe
          ? {
              ...probe.nextState,
              lastFullReconcileAt:
                mode === "full"
                  ? new Date().toISOString()
                  : (previousState?.lastFullReconcileAt ?? null),
            }
          : null;

      // ---- Phase 1: groups (completion-gated stale sweep). Not resumed
      // mid-way — small and dedupable; a restart re-marks and re-observes.
      //
      // Per-step failure isolation is retained for legacy connectors. Connectors
      // that declare atomic security sync abort the pass if groups fail, so the
      // journal cursor never commits past a security change. In both cases the
      // completion-gated diff preserves the prior snapshot on interruption. ----
      // Sources with an authoritative, gap-detecting journal enumerate only
      // dirty groups on delta passes. Other sources retain the conservative
      // full-membership verification behavior.
      const authoritativeGroupScope =
        mode === "delta" && probe?.authoritativeAudienceScope === true;
      const dirtyGroupIds = [...new Set(probe?.dirtyGroupIds ?? [])];
      const deletedGroupIds = [...new Set(probe?.deletedGroupIds ?? [])];
      const affectedGroupIds = [
        ...new Set([...dirtyGroupIds, ...deletedGroupIds]),
      ];
      const shouldSyncGroups =
        connectorImpl.syncGroups &&
        (!authoritativeGroupScope || affectedGroupIds.length > 0);
      if (shouldSyncGroups && connectorImpl.syncGroups) {
        // Counted separately from `stats` so the persisted numbers stay
        // honest on failure: `membershipsUpserted` only ever reflects batches
        // that actually landed (a mid-pass throw once reported 75 upserted
        // memberships while zero persisted).
        let groupsEnumerated = 0;
        let membershipsPersisted = 0;
        let membershipsRemoved = 0;
        try {
          // Diff-based reconcile: unchanged memberships cost ZERO writes.
          // Revoked memberships are deleted only after the enumeration
          // completes (completion-gated), so an interrupted run never drops a
          // membership it simply had not reached; on failure the previous
          // snapshot stays fully resolvable.
          const current = authoritativeGroupScope
            ? await KbExternalUserGroupModel.findMembershipSnapshotByGroups({
                connectorId,
                groupIds: affectedGroupIds,
              })
            : await KbExternalUserGroupModel.findMembershipSnapshotByConnector(
                connectorId,
              );
          const membershipKey = (groupId: string, accountId: string) =>
            `${groupId}\u0000${accountId}`;
          const currentByKey = new Map(
            current.map((row) => [
              membershipKey(row.groupId, row.externalAccountId),
              row,
            ]),
          );
          const seen = new Set<string>();
          const seenGroupIds = new Set<string>();
          let pending: InsertKbExternalUserGroup[] = [];
          const pendingGroups: InsertKbExternalGroup[] = [];
          for await (const group of connectorImpl.syncGroups({
            config: connector.config as Record<string, unknown>,
            identity,
            credentials,
            cursor: null,
            readIngestedDocuments,
            refreshIdentities,
            ...(authoritativeGroupScope
              ? { scope: { containerKeys: [], groupIds: dirtyGroupIds } }
              : {}),
          })) {
            groupsEnumerated += 1;
            seenGroupIds.add(group.groupId);
            pendingGroups.push({
              organizationId: connector.organizationId,
              connectorId,
              connectorType: connector.connectorType,
              groupId: group.groupId,
              name: group.name ?? null,
            });
            if (group.membershipResolutionFailed) {
              runLog.warn(
                { groupId: group.groupId, groupName: group.name ?? null },
                "Group membership could not be resolved; replacing it with an empty fail-closed membership",
              );
            }
            for (const member of group.members) {
              const key = membershipKey(group.groupId, member.accountId);
              seen.add(key);
              const existing = currentByKey.get(key);
              const memberEmail = member.email
                ? normalizeEmail(member.email)
                : null;
              const displayName = member.displayName ?? null;
              const accountType = member.accountType ?? null;
              if (
                existing &&
                existing.memberEmail === memberEmail &&
                existing.displayName === displayName &&
                existing.accountType === accountType
              ) {
                continue;
              }
              // Every NEW member is persisted — a hidden upstream email is
              // stored as NULL (fail-closed at resolution, visible to admins)
              // rather than dropping the principal.
              pending.push({
                organizationId: connector.organizationId,
                connectorId,
                connectorType: connector.connectorType,
                groupId: group.groupId,
                externalAccountId: member.accountId,
                displayName,
                memberEmail,
                accountType,
              });
            }
            if (pending.length >= this.batchSize) {
              await this.assertStillOwnsRun({ runId, epoch });
              if (
                !(await KbExternalUserGroupModel.upsertMany(pending, fence))
              ) {
                throw new LeaseLostError();
              }
              membershipsPersisted += pending.length;
              pending = [];
              await yieldToEventLoop();
            }
          }
          if (pending.length > 0) {
            await this.assertStillOwnsRun({ runId, epoch });
            if (!(await KbExternalUserGroupModel.upsertMany(pending, fence))) {
              throw new LeaseLostError();
            }
            membershipsPersisted += pending.length;
          }
          for (let i = 0; i < pendingGroups.length; i += this.batchSize) {
            await this.assertStillOwnsRun({ runId, epoch });
            await KbExternalGroupModel.upsertMany(
              pendingGroups.slice(i, i + this.batchSize),
            );
          }
          // Completion-gated diff delete of revoked memberships. Read off the
          // map's VALUES rather than by splitting its keys apart again: the
          // stored row already carries both fields, so the composite key stays
          // a write-only join key that nothing has to parse back into one.
          const revoked = [...currentByKey.entries()]
            .filter(([key]) => !seen.has(key))
            .map(([, row]) => ({
              groupId: row.groupId,
              externalAccountId: row.externalAccountId,
            }));
          for (let i = 0; i < revoked.length; i += this.batchSize) {
            await this.assertStillOwnsRun({ runId, epoch });
            membershipsRemoved += await KbExternalUserGroupModel.deleteByKeys({
              connectorId,
              keys: revoked.slice(i, i + this.batchSize),
            });
            await yieldToEventLoop();
          }
          if (authoritativeGroupScope) {
            // Deleted groups are absent by definition; dirty groups that were
            // requested but not returned are also treated as deleted. The
            // journal is authoritative and the connector has completed the
            // scoped read, so retaining either would be fail-open.
            const absent = affectedGroupIds.filter(
              (groupId) => !seenGroupIds.has(groupId),
            );
            await KbExternalUserGroupModel.deleteByGroupIds({
              connectorId,
              groupIds: absent,
            });
            await KbExternalGroupModel.deleteByGroupIds({
              connectorId,
              groupIds: absent,
            });
          } else {
            await KbExternalGroupModel.deleteAbsent({
              connectorId,
              seenGroupIds: [...seenGroupIds],
            });
          }
          stats.groupsSynced = groupsEnumerated;
          stats.membershipsUpserted = membershipsPersisted;
          // A removal-only refresh (someone lost access upstream) must not
          // read as "nothing changed" — the removal IS the change.
          stats.membershipsRemoved = membershipsRemoved;
        } catch (error) {
          // Losing the run is not a group-step failure to be absorbed: this
          // pass has no authority to write anything at all any more, so it
          // must not fall through to the document reconcile below. The catch
          // exists for an upstream group read that failed, not for this.
          if (error instanceof LeaseLostError) throw error;
          stats.groupsSynced = groupsEnumerated;
          stats.membershipsUpserted = membershipsPersisted;
          // Deletions that completed before the failure are real revocations
          // — they must not vanish from the run stats.
          stats.membershipsRemoved = membershipsRemoved;
          stats.groupSyncFailed = true;
          runLog.warn(
            {
              error: extractErrorMessage(error),
              // Query errors (e.g. Drizzle) carry the actionable Postgres
              // error in `cause`, not in the message.
              cause:
                error instanceof Error && error.cause
                  ? extractErrorMessage(error.cause)
                  : undefined,
            },
            "Permission sync group step failed; continuing to document reconcile with the previous group snapshot",
          );
          metrics.rag.reportPermissionSyncGroupFailure(connector.connectorType);
          if (connectorImpl.requiresAtomicSecuritySync) throw error;
        }
      }

      const resumeCursor = priorCheckpoint?.cursor ?? null;
      await this.checkpoint(
        runId,
        epoch,
        { phase: "snapshot", cursor: resumeCursor },
        stats,
      );

      // ---- Phase 2: container snapshot (per-container set-diff reconcile) ----
      const totalDocs = await KbDocumentModel.countByConnector(connectorId);
      stats.totalDocs = totalDocs;
      if (totalDocs === 0) {
        // Fast-exit: nothing ingested yet. New content is fail-closed until a
        // later pass (content-sync creates auto-sync docs with acl=[]).
        runLog.info("No documents yet; permission pass fast-exits");
        await this.finishSuccessfulPass({
          connectorId,
          connectorType: connector.connectorType,
          runId,
          epoch,
          startedAt,
          stats,
          getLogOutput,
          nextSyncState: nextSyncState(),
        });
        return { runId, status: "success" };
      }

      // ---- Delta scope: the probe's upstream-dirty containers UNION the
      // containers of locally-unassigned documents. The probe sees only
      // UPSTREAM drift — a document that is locally new but upstream old (a
      // crawl backfill, a resumed initial sync, an ingest completing after the
      // last pass enumerated) never dirties anything upstream, so without the
      // local side it would stay fail-closed until the periodic full
      // reconcile. Metadata is used for SCOPING only; the assignment itself
      // still comes from the authoritative enumeration below. ----
      // Admin member mappings, preloaded so connector hooks materialize a
      // mapped account's email in DIRECT grants (see ResolveMappedEmail).
      const mappedEmails =
        await KbMemberOverrideModel.findMappedEmailsByConnector(connectorId);
      const resolveMappedEmail = (externalAccountId: string) =>
        mappedEmails.get(externalAccountId) ?? null;

      let deltaContainerKeys: string[] | null = null;
      if (mode === "delta" && probe) {
        // ---- Audience verification: authoritative journals re-resolve only
        // dirty containers; conservative probes re-resolve every stored row.
        // Both paths write only changed audiences and scan zero documents.
        // Mapping edits materialize through the same refresh path. ----
        if (connectorImpl.refreshContainerAudiences) {
          await this.refreshStoredContainerAudiences({
            connector,
            identity,
            connectorImpl,
            credentials,
            resolveMappedEmail,
            readIngestedDocuments,
            containerKeys: probe.authoritativeAudienceScope
              ? probe.dirtyContainerKeys
              : undefined,
            stats,
            runLog,
            fence: { runId, epoch },
          });
        }

        const scopeKeys = new Set(probe.dirtyContainerKeys);
        if (connectorImpl.scopeKeyForDocument) {
          const local = await this.collectUnassignedScopeKeys({
            connectorImpl,
            connectorId,
          });
          for (const key of local.scopeKeys) scopeKeys.add(key);
          if (local.scopeKeys.size > 0 || local.unscopable > 0) {
            runLog.info(
              {
                adoptionScopeKeys: [...local.scopeKeys],
                // Unassigned docs whose metadata cannot place them wait for
                // the periodic full reconcile (fail-closed meanwhile).
                unscopableUnassignedDocs: local.unscopable,
              },
              "Delta scope expanded to adopt locally-unassigned documents",
            );
          }
        }

        if (scopeKeys.size === 0) {
          // No document-level drift since the recorded cursor and no documents
          // awaiting adoption. The exact dirty audience/group scope, if any,
          // already completed above.
          runLog.info(
            "Delta pass applied its authoritative security scope; no documents require reassignment",
          );
          await this.finishSuccessfulPass({
            connectorId,
            connectorType: connector.connectorType,
            runId,
            epoch,
            startedAt,
            stats,
            getLogOutput,
            nextSyncState: nextSyncState(),
          });
          return { runId, status: "success" };
        }
        deltaContainerKeys = [...scopeKeys];
      }

      if (resumeCursor === null && mode === "full") {
        // Fresh full enumeration: arm the vanished-container sweep. A resumed
        // run keeps the marks from its original attempt — containers it
        // completed already cleared theirs by re-upserting. Delta passes never
        // mark or sweep (their enumeration is scoped, not end-to-end).
        await KbContainerAclModel.markStaleByConnector(connectorId);
      }

      // Last COMPLETED top-level container; mid-container flushes checkpoint
      // this value so a resume re-enumerates the in-flight container fully.
      let lastCompletedUnit: string | null = resumeCursor;
      let unit: UnitState | null = null;

      const generator = connectorImpl.syncPermissionSnapshot?.({
        config: connector.config as Record<string, unknown>,
        identity,
        credentials,
        cursor: resumeCursor,
        readIngestedDocuments,
        resolveMappedEmail,
        refreshIdentities,
        ...(deltaContainerKeys
          ? { scope: { containerKeys: deltaContainerKeys } }
          : {}),
      });
      if (generator) {
        for await (const item of generator) {
          if (!unit || item.cursor !== unit.key) {
            if (unit) {
              // Before the unit's writes, which fail-close documents the unit
              // did not see — the most destructive write the pass makes.
              await this.assertStillOwnsRun({ runId, epoch });
              await this.finishUnit({ connector, unit, stats, aclConfigEpoch });
              lastCompletedUnit = unit.key;
              snapshotProgressed = true;
              await this.checkpoint(
                runId,
                epoch,
                { phase: "snapshot", cursor: lastCompletedUnit },
                stats,
              );
              await yieldToEventLoop();
            }
            unit = { key: item.cursor, seen: new Set(), pending: [] };
          }

          if (item.kind === "container") {
            stats.containersSynced = (stats.containersSynced ?? 0) + 1;
            // One at a time here, unlike the delta refresh: containers arrive
            // interleaved with the documents that reference them, and holding
            // one back past a checkpoint would resume into documents whose
            // container row was never written.
            const changed = await this.upsertContainers({
              connector,
              batch: [
                {
                  containerKey: item.containerKey,
                  permissions: item.permissions,
                  fingerprint: item.fingerprint ?? null,
                  audienceResolutionFailed:
                    item.audienceResolutionFailed ?? false,
                },
              ],
              // A full enumeration marks every row stale up front, so even an
              // unchanged container must be re-written to clear its mark.
              clearsStaleMarks: true,
              stats,
              runLog,
              fence: { runId, epoch },
            });
            stats.containersChanged = (stats.containersChanged ?? 0) + changed;
          } else {
            stats.docsScanned += 1;
            unit.seen.add(item.sourceId);
            unit.pending.push({
              sourceId: item.sourceId,
              containerKey: item.containerKey,
              exceptionUsers: item.exceptionUsers,
            });
            if (unit.pending.length >= this.batchSize) {
              await this.assertStillOwnsRun({ runId, epoch });
              await this.flushAssignments({
                connector,
                batch: unit.pending.splice(0),
                stats,
                aclConfigEpoch,
              });
              await this.checkpoint(
                runId,
                epoch,
                { phase: "snapshot", cursor: lastCompletedUnit },
                stats,
              );
              await yieldToEventLoop();
            }
          }
        }
        if (unit) {
          await this.assertStillOwnsRun({ runId, epoch });
          await this.finishUnit({ connector, unit, stats, aclConfigEpoch });
          lastCompletedUnit = unit.key;
          snapshotProgressed = true;
          await this.checkpoint(
            runId,
            epoch,
            { phase: "snapshot", cursor: lastCompletedUnit },
            stats,
          );
        }
      }

      if (mode === "full") {
        // ---- Vanished-container sweep (only after end-to-end enumeration).
        // Container rows still stale were not re-observed upstream (deleted
        // space/project/repo, or a lifted restriction whose documents were
        // reassigned above): fail-close any documents still assigned to them,
        // then drop the rows. ----
        await this.sweepVanishedContainers({
          connector,
          stats,
          aclConfigEpoch,
        });

        // ---- Unassigned sweep. A document the enumeration never assigned to
        // any container (container_key still NULL) was not visible upstream:
        // either a pre-container-model document whose source vanished, or one
        // deleted before its first pass. Every document the enumeration DID
        // see had its container_key written above, so what is left is
        // fail-closed. (Freshly ingested docs are acl=[] already — a no-op.)
        stats.failClosed += await this.failCloseMissingInScope({
          connector,
          topLevelContainerKey: null,
          seenSourceIds: EMPTY_SOURCE_ID_SET,
          aclConfigEpoch,
        });
      }

      runLog.info({ ...stats }, "Permission sync pass complete");

      await this.finishSuccessfulPass({
        connectorId,
        connectorType: connector.connectorType,
        runId,
        epoch,
        startedAt,
        stats,
        getLogOutput,
        nextSyncState: nextSyncState(),
      });
      return { runId, status: "success" };
    } catch (error) {
      if (error instanceof LeaseLostError) {
        // Someone else owns this connector now — a settings edit superseded
        // this pass, or the reaper declared it dead and a replacement ran.
        // That owner has already written the run's terminal row and the
        // connector's status; anything written here would overwrite a newer
        // truth with an older one. Leaving quietly IS the correct ending.
        runLog.info(
          "Permission run was reclaimed while it was running; stopping without writing",
        );
        return { runId, status: "superseded" };
      }
      const message = extractErrorMessage(error);
      // A run that advanced its snapshot cursor is `partial` (checkpoint
      // preserved; a re-enqueued resume picks up from the last completed
      // container, and a partial pass never runs the vanished-container
      // sweep). A run that made NO progress is `failed`: re-running it
      // immediately would hit the same error again, so no continuation is
      // enqueued and the next scheduled pass is the retry.
      const status = snapshotProgressed ? "partial" : "failed";
      runLog.error({ error: message, status }, "Permission sync pass failed");
      const owned = await ConnectorRunModel.updateIfOwned({
        runId,
        epoch,
        data: {
          status,
          error: message,
          completedAt: new Date(),
          ...(getLogOutput ? { logs: getLogOutput() } : {}),
        },
      });
      // `stats` is scoped to the try block (it captures the content-run check);
      // the terminal row keeps whatever the last checkpoint persisted.
      // Mirrored onto the connector only while we still own the run: a pass
      // reclaimed between its last check and this one must not stamp `failed`
      // over the success a replacement pass already recorded.
      if (owned) {
        await KnowledgeBaseConnectorModel.update(connectorId, {
          lastPermissionSyncStatus: status,
        });
      }
      metrics.rag.reportPermissionSync({
        connectorType: connector.connectorType,
        status,
      });
      return { runId, status };
    }
  }

  /**
   * Audience-verification phase: re-resolve either the probe's authoritative
   * dirty scope or every stored container for conservative probes, and write
   * only rows whose audience changed. Documents and chunks are never touched;
   * they reference the
   * container by token. Keys the connector does not yield back (it cannot
   * refresh them without an assignment reconcile) keep their stored audience
   * until the periodic full reconcile.
   */
  private async refreshStoredContainerAudiences(params: {
    identity: ConnectorIdentity;
    connector: KnowledgeBaseConnector;
    connectorImpl: Connector;
    credentials: ConnectorCredentials;
    resolveMappedEmail: ResolveMappedEmail;
    readIngestedDocuments: ReadIngestedDocuments;
    containerKeys?: string[];
    stats: PermissionSyncRunStats;
    runLog: pino.Logger;
    /** The run whose ownership authorises these writes. */
    fence: { runId: string; epoch: number };
  }): Promise<void> {
    const {
      connector,
      connectorImpl,
      credentials,
      identity,
      resolveMappedEmail,
      readIngestedDocuments,
      stats,
      runLog,
    } = params;
    if (!connectorImpl.refreshContainerAudiences) return;
    const containerKeys =
      params.containerKeys ??
      (await KbContainerAclModel.findKeysByConnector(connector.id));
    if (containerKeys.length === 0) return;

    let refreshed = 0;
    let pending: ContainerAudience[] = [];
    const flush = async () => {
      stats.containersChanged =
        (stats.containersChanged ?? 0) +
        (await this.upsertContainers({
          connector,
          batch: pending,
          // A delta pass marks nothing stale, so it has no marks to clear and
          // an unchanged container costs no write at all — which is the whole
          // promise of a delta pass. (A mark left behind by an interrupted full
          // pass is still honored: `upsertContainers` rewrites a stale row even
          // when its audience is unchanged.)
          clearsStaleMarks: false,
          stats,
          runLog,
          fence: params.fence,
        }));
      pending = [];
    };
    for await (const item of connectorImpl.refreshContainerAudiences({
      config: connector.config as Record<string, unknown>,
      identity,
      credentials,
      containerKeys,
      readIngestedDocuments,
      resolveMappedEmail,
    })) {
      refreshed += 1;
      stats.containersSynced = (stats.containersSynced ?? 0) + 1;
      pending.push({
        containerKey: item.containerKey,
        permissions: item.permissions,
        fingerprint: item.fingerprint ?? null,
        audienceResolutionFailed: item.audienceResolutionFailed ?? false,
      });
      // Nothing reads a container row mid-refresh, so the audiences buffer:
      // the pass's cost belongs in the upstream calls above, not in a DB
      // round-trip per space.
      if (pending.length >= this.batchSize) {
        await flush();
        await yieldToEventLoop();
      }
    }
    if (pending.length > 0) {
      await flush();
    }
    runLog.info(
      {
        storedContainers: containerKeys.length,
        refreshed,
        audiencesChanged: stats.containersChanged ?? 0,
      },
      "Audience verification complete — stored container audiences re-resolved upstream, no document enumeration",
    );
  }

  /**
   * Map every locally-unassigned document (`container_key IS NULL` — ingested
   * but never adopted by a pass) to its top-level container scope key via the
   * connector's pure metadata mapping. Keyset scan, O(batch) memory, zero
   * upstream requests; the scan is empty in steady state. Documents whose
   * metadata cannot be placed are counted and left for the periodic full
   * reconcile (fail-closed meanwhile).
   */
  private async collectUnassignedScopeKeys(params: {
    connectorImpl: Connector;
    connectorId: string;
  }): Promise<{ scopeKeys: Set<string>; unscopable: number }> {
    const { connectorImpl, connectorId } = params;
    const scopeKeys = new Set<string>();
    let unscopable = 0;
    let afterId: string | null = null;
    for (;;) {
      const rows = await KbDocumentModel.findUnassignedDocMetadata({
        connectorId,
        afterId,
        limit: this.batchSize,
      });
      for (const row of rows) {
        const key = row.metadata
          ? (connectorImpl.scopeKeyForDocument?.(row.metadata) ?? null)
          : null;
        if (key) scopeKeys.add(key);
        else unscopable += 1;
      }
      if (rows.length < this.batchSize) break;
      afterId = rows[rows.length - 1].id;
      await yieldToEventLoop();
    }
    return { scopeKeys, unscopable };
  }

  /**
   * Upsert a batch of container audience rows, returning how many of their
   * audiences actually changed — the pass's headline number, since ONE changed
   * container row is the entire write cost of an upstream audience change.
   * Each audience is built through the same authority as document ACLs (cap +
   * `org:*` over-approximation included).
   *
   * Only rows that actually need writing are written. A delta pass re-resolves
   * EVERY stored container to verify it, and the steady-state answer is "still
   * the same" — so an unchanged container must cost nothing, or a connector with
   * thousands of spaces rewrites its whole container table every half hour for
   * no reason. A row is written when its audience changed, its fingerprint
   * changed, it does not exist yet, or it carries a stale mark that only an
   * upsert clears (`clearsStaleMarks`: a full pass marks every row up front and
   * sweeps whatever is still marked afterwards, so on that path an unchanged
   * container MUST still be rewritten or the sweep would delete it and
   * fail-close every document in it).
   */
  private async upsertContainers(params: {
    connector: KnowledgeBaseConnector;
    batch: ContainerAudience[];
    clearsStaleMarks: boolean;
    stats: PermissionSyncRunStats;
    runLog: pino.Logger;
    /** The run whose ownership authorises these writes. */
    fence: { runId: string; epoch: number };
  }): Promise<number> {
    const { connector, batch, clearsStaleMarks, stats, runLog, fence } = params;
    if (batch.length === 0) return 0;

    // Keyed, so a container yielded twice in one batch collapses to its last
    // audience — what sequential upserts did, and what `ON CONFLICT` demands
    // (a key repeated inside one INSERT is a Postgres error).
    const rows = new Map<string, InsertKbContainerAcl>();
    const unreadable: string[] = [];
    for (const item of batch) {
      const { containerKey, permissions, fingerprint } = item;
      if (item.audienceResolutionFailed) unreadable.push(containerKey);
      rows.set(containerKey, {
        organizationId: connector.organizationId,
        connectorId: connector.id,
        containerKey,
        acl: buildDocumentAccessControlList({
          visibility: "auto-sync-permissions",
          teamIds: connector.teamIds,
          connectorType: connector.connectorType,
          permissions: permissions as
            | { users?: string[]; groups?: string[]; isPublic?: boolean }
            | undefined,
        }),
        fingerprint,
      });
    }

    // A container we could not read the permissions of stores an empty audience
    // and so hides every document in it — the same end state as a container
    // upstream grants nobody, which is why it cannot be left to a warn line in
    // the connector. It is an error and it is counted on the run.
    if (unreadable.length > 0) {
      stats.containerAudienceFailures =
        (stats.containerAudienceFailures ?? 0) + unreadable.length;
      runLog.error(
        { containerKeys: unreadable.slice(0, 20), count: unreadable.length },
        "Could not read the upstream permissions of these containers; every document in them is fail-closed for this pass (check the connector credential's admin scope)",
      );
      metrics.rag.reportPermissionSyncContainerAudienceFailures({
        connectorType: connector.connectorType,
        count: unreadable.length,
      });
    }

    const existing = await KbContainerAclModel.findAudienceStateByKeys({
      connectorId: connector.id,
      containerKeys: [...rows.keys()],
    });
    let changed = 0;
    const toWrite: InsertKbContainerAcl[] = [];
    for (const [containerKey, row] of rows) {
      const previous = existing.get(containerKey);
      const audienceChanged =
        previous === undefined ||
        !aclEquals(previous.acl, row.acl) ||
        previous.fingerprint !== (row.fingerprint ?? null);
      if (audienceChanged) changed += 1;
      if (audienceChanged || (clearsStaleMarks && previous?.stale)) {
        toWrite.push(row);
      }
    }

    const written = await KbContainerAclModel.upsertMany(toWrite, fence);
    if (!written) throw new LeaseLostError();
    return changed;
  }

  /**
   * Reconcile a batch of upstream document assignments against the stored
   * state: adopt documents never assigned (freshly ingested, `acl=[]`),
   * reassign documents whose container changed (moved issue/page, applied or
   * lifted restriction), and rewrite per-document exception changes. Only
   * changed documents cost writes.
   */
  private async flushAssignments(params: {
    connector: KnowledgeBaseConnector;
    batch: {
      sourceId: string;
      containerKey: string;
      exceptionUsers?: string[];
    }[];
    stats: PermissionSyncRunStats;
    aclConfigEpoch: number;
  }): Promise<void> {
    const { connector, batch, stats, aclConfigEpoch } = params;
    if (batch.length === 0) return;

    const bySourceId = new Map(batch.map((item) => [item.sourceId, item]));
    const current = await KbDocumentModel.findAclStateBySourceIds({
      connectorId: connector.id,
      sourceIds: [...bySourceId.keys()],
    });

    for (const doc of current) {
      const assignment = doc.sourceId ? bySourceId.get(doc.sourceId) : null;
      if (!assignment) continue;

      const nextAcl = buildAssignmentAcl({
        connectorId: connector.id,
        containerKey: assignment.containerKey,
        exceptionUsers: assignment.exceptionUsers,
      });
      if (
        doc.containerKey === assignment.containerKey &&
        aclEquals(doc.acl, nextAcl)
      ) {
        continue;
      }

      // The document row and its chunks move together, in one epoch-fenced
      // statement — see `applyContainerAssignment`. Splitting them across two
      // fenced statements let a visibility switch land in between and fence out
      // only the second, leaving the chunks (which the search filter reads)
      // holding a container token the document row never got.
      const { documentUpdated, chunksRewritten } =
        await KbDocumentModel.applyContainerAssignment({
          documentId: doc.id,
          connectorId: connector.id,
          acl: nextAcl,
          containerKey: assignment.containerKey,
          aclConfigEpoch,
        });
      stats.chunksRewritten += chunksRewritten;
      if (documentUpdated) {
        stats.aclsChanged += 1;
        if (doc.containerKey === null) {
          stats.docsAdopted = (stats.docsAdopted ?? 0) + 1;
        } else if (doc.containerKey !== assignment.containerKey) {
          stats.docsReassigned = (stats.docsReassigned ?? 0) + 1;
        }
      }
    }
    // Source ids with no stored document were not ingested by content-sync
    // yet — skipped; ingest creates them fail-closed for the next pass.
  }

  /**
   * Complete one top-level container: flush its remaining assignments, then
   * fail-close documents still assigned to its scope (the container itself or
   * a nested `<container>/<child>` exception) whose source ids the completed
   * upstream enumeration did not contain. Safe mid-pass — the diff is scoped
   * to exactly this fully-enumerated container.
   */
  private async finishUnit(params: {
    connector: KnowledgeBaseConnector;
    unit: UnitState;
    stats: PermissionSyncRunStats;
    aclConfigEpoch: number;
  }): Promise<void> {
    const { connector, unit, stats, aclConfigEpoch } = params;
    await this.flushAssignments({
      connector,
      batch: unit.pending.splice(0),
      stats,
      aclConfigEpoch,
    });
    stats.failClosed += await this.failCloseMissingInScope({
      connector,
      topLevelContainerKey: unit.key,
      seenSourceIds: unit.seen,
      aclConfigEpoch,
    });
  }

  /**
   * Fail-close every document assigned to a container scope whose sourceId is
   * not in `seenSourceIds` (empty set = fail-close the whole scope). Keyset
   * scan + bounded write batches. Returns the number fail-closed.
   */
  private async failCloseMissingInScope(params: {
    connector: KnowledgeBaseConnector;
    /** Null scope = documents never assigned to a container. */
    topLevelContainerKey: string | null;
    seenSourceIds: ReadonlySet<string>;
    aclConfigEpoch: number;
  }): Promise<number> {
    const { connector, topLevelContainerKey, seenSourceIds, aclConfigEpoch } =
      params;
    let failClosed = 0;
    let afterId: string | null = null;
    const toClose: string[] = [];
    for (;;) {
      const rows = await KbDocumentModel.findDocRefsByContainerScope({
        connectorId: connector.id,
        topLevelContainerKey,
        afterId,
        limit: this.batchSize,
      });
      for (const row of rows) {
        if (!row.sourceId || !seenSourceIds.has(row.sourceId)) {
          toClose.push(row.id);
        }
      }
      if (toClose.length >= this.batchSize) {
        failClosed += await KbDocumentModel.failCloseDocuments({
          documentIds: toClose.splice(0),
          connectorId: connector.id,
          aclConfigEpoch,
        });
        await yieldToEventLoop();
      }
      if (rows.length < this.batchSize) break;
      afterId = rows[rows.length - 1].id;
    }
    if (toClose.length > 0) {
      failClosed += await KbDocumentModel.failCloseDocuments({
        documentIds: toClose,
        connectorId: connector.id,
        aclConfigEpoch,
      });
    }
    return failClosed;
  }

  private async sweepVanishedContainers(params: {
    connector: KnowledgeBaseConnector;
    stats: PermissionSyncRunStats;
    aclConfigEpoch: number;
  }): Promise<void> {
    const { connector, stats, aclConfigEpoch } = params;
    const staleRows = await KbContainerAclModel.findStaleByConnector(
      connector.id,
    );
    for (const row of staleRows) {
      stats.failClosed += await this.failCloseMissingInScope({
        connector,
        topLevelContainerKey: row.containerKey,
        seenSourceIds: EMPTY_SOURCE_ID_SET,
        aclConfigEpoch,
      });
      await yieldToEventLoop();
    }
    await KbContainerAclModel.sweepStaleByConnector(connector.id);
  }

  private async checkpoint(
    runId: string,
    epoch: number,
    checkpoint: PermissionSyncCheckpoint,
    stats?: PermissionSyncRunStats,
  ): Promise<void> {
    const owned = await ConnectorRunModel.updateIfOwned({
      runId,
      epoch,
      // Stats ride along with every checkpoint so a running pass shows live
      // progress (they are cheap — same fenced UPDATE).
      data: { checkpoint, ...(stats ? { stats: { ...stats } } : {}) },
    });
    // The fenced UPDATE not matching is the signal that this pass no longer
    // owns its run. Discarding it was how a thawed worker got to keep writing.
    if (!owned) throw new LeaseLostError();
  }

  /**
   * Renew the lease and stop the pass if it has been reclaimed.
   *
   * Called immediately BEFORE each unit of ACL writes, not after: the point is
   * to not write at all once a newer pass owns the connector. Renewing here
   * also couples liveness to actual work, so a unit that takes minutes starts
   * with a full lease TTL of headroom rather than depending on the heartbeat
   * timer, which a blocked event loop starves.
   *
   * The same shape as the content family's per-batch check in
   * `connector-sync.ts`; the permission family reads its own writes through
   * `kb_container_acls`, where a stale audience silently restores access.
   */
  private async assertStillOwnsRun(params: {
    runId: string;
    epoch: number;
  }): Promise<void> {
    const held = await ConnectorRunModel.renewLease({
      runId: params.runId,
      owner: WORKER_ID,
      epoch: params.epoch,
      leaseTtlSeconds: config.kb.connectorRunLeaseTtlSeconds,
    });
    if (!held) throw new LeaseLostError();
  }

  /**
   * Success bookkeeping shared by every successful exit: finalize the run,
   * report the metric, and persist the probe's next cursors (plus the full-
   * reconcile timestamp) — ONLY here, so an interrupted pass re-probes from
   * the cursors it started with.
   */
  private async finishSuccessfulPass(params: {
    connectorId: string;
    connectorType: KnowledgeBaseConnector["connectorType"];
    runId: string;
    epoch: number;
    startedAt: Date;
    stats: PermissionSyncRunStats;
    getLogOutput?: () => string;
    nextSyncState: PermissionSyncState | null;
  }): Promise<void> {
    const owned = await this.finalize({
      connectorId: params.connectorId,
      runId: params.runId,
      epoch: params.epoch,
      startedAt: params.startedAt,
      stats: params.stats,
      getLogOutput: params.getLogOutput,
    });
    // Every write below describes THIS pass's view of upstream. A pass that
    // lost its run mid-flight has an older view than whoever took it over, and
    // `permissionSyncState` is the probe fingerprint the next pass diffs
    // against: writing a stale one there makes the next pass skip real
    // changes. So the pass ends silently rather than reporting.
    if (!owned) throw new LeaseLostError();
    if (params.nextSyncState) {
      await KnowledgeBaseConnectorModel.update(params.connectorId, {
        permissionSyncState: params.nextSyncState,
      });
    }
    metrics.rag.reportPermissionSync({
      connectorType: params.connectorType,
      status: "success",
    });
  }

  private async finalize(params: {
    connectorId: string;
    runId: string;
    epoch: number;
    startedAt: Date;
    stats?: PermissionSyncRunStats;
    getLogOutput?: () => string;
  }): Promise<boolean> {
    const owned = await ConnectorRunModel.updateIfOwned({
      runId: params.runId,
      epoch: params.epoch,
      data: {
        status: "success",
        completedAt: new Date(),
        ...(params.stats ? { stats: { ...params.stats } } : {}),
        ...(params.getLogOutput ? { logs: params.getLogOutput() } : {}),
      },
    });
    // Only mirror the status if we still owned the run (not reclaimed).
    if (owned) {
      await KnowledgeBaseConnectorModel.update(params.connectorId, {
        lastPermissionSyncStatus: "success",
      });
    }
    return !!owned;
  }
}

export const permissionSyncService = new PermissionSyncService();

// ===== Internal helpers =====

const EMPTY_SOURCE_ID_SET: ReadonlySet<string> = new Set();

/**
 * This pass no longer owns its run: it was superseded by a settings edit, or
 * reclaimed after its lease expired and a replacement has since run.
 *
 * Thrown rather than returned because every remaining step of the pass would
 * write a view of upstream that is older than the current owner's, and the
 * call stack at the point of discovery is many frames deep in an enumeration.
 * Caught in `runClaimedPass`, where it ends the pass without touching the run
 * row or the connector.
 */
class LeaseLostError extends Error {
  constructor() {
    super("The permission run was reclaimed by another pass");
  }
}

/**
 * A document's ACL under the container model: its `container:` token plus any
 * per-document exception principals — a handful of entries, never the
 * materialized audience (that lives on the container row).
 */
function buildAssignmentAcl(params: {
  connectorId: string;
  containerKey: string;
  exceptionUsers?: string[];
}): AclEntry[] {
  const acl: AclEntry[] = [
    buildContainerToken({
      connectorId: params.connectorId,
      containerKey: params.containerKey,
    }),
  ];
  for (const email of params.exceptionUsers ?? []) {
    acl.push(`user_email:${normalizeEmail(email)}`);
  }
  return [...new Set(acl)];
}

/**
 * Order-insensitive ACL comparison. Called once per document on a full
 * reconcile, so the dominant case settles without allocating: both sides came
 * out of `buildAssignmentAcl`, which emits the container token first and the
 * exceptions in a stable order, and an unchanged document compares equal
 * position by position. The sort is the fallback for container audiences,
 * whose principal order no upstream promises to keep between passes.
 */
function aclEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  if (a.every((entry, index) => entry === b[index])) return true;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((entry, index) => entry === sortedB[index]);
}

/**
 * The connector's identity, handed to every extraction hook. Connectors that
 * provision their own runtime key it off this so one connector's credentials
 * never pass through another's infrastructure, and so an edit retires that
 * runtime — see {@link ConnectorIdentity}.
 */
async function connectorIdentity(
  connector: KnowledgeBaseConnector,
  run?: { runId: string; epoch: number },
): Promise<ConnectorIdentity> {
  return {
    connectorId: connector.id,
    organizationId: connector.organizationId,
    environmentId: connector.environmentId,
    secretId: connector.secretId,
    ...(run ? { run } : {}),
    credentialVersion: await resolveConnectorCredentialVersion(
      connector.secretId,
    ),
  };
}
