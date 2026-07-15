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
  KbExternalUserGroupModel,
  KbMemberOverrideModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import * as metrics from "@/observability/metrics";
import type {
  AclEntry,
  Connector,
  ConnectorCredentials,
  InsertKbContainerAcl,
  InsertKbExternalUserGroup,
  KnowledgeBaseConnector,
  PermissionProbeResult,
  PermissionSyncRunStats,
  PermissionSyncState,
  ReadIngestedDocuments,
  ResolveMappedEmail,
} from "@/types";
import { buildContainerToken, normalizeEmail } from "./acl-tokens";
import { resolveConnectorCredentials } from "./connector-credentials";
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

    try {
      const credentials = await resolveConnectorCredentials(connector);
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
      // Delta passes VERIFY, never infer: every one re-resolves all stored
      // container audiences (O(containers) upstream requests) and re-syncs
      // group memberships, so any upstream permission change — however it was
      // (or wasn't) audited — lands on the next pass. A connector that can
      // probe but cannot refresh audiences has no delta mode.
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
      // Per-step failure isolation: the group step and the document reconcile
      // (Phase 2) are two independent steps of the one pass. A group-enumeration
      // failure is logged + metered but MUST NOT abort Phase 2 — documents still
      // reconcile against the previous group snapshot. On failure we skip the
      // completion-gated revoked-membership delete, so the prior snapshot's rows
      // (now flagged stale, but `findGroupTokensForUser` ignores the flag) stay
      // resolvable until a later pass enumerates cleanly. ----
      // Runs on EVERY pass, delta included: membership drift is verified by
      // re-enumeration (diff-based, unchanged memberships cost zero writes),
      // never inferred from audit events — see PermissionProbeResult.
      if (connectorImpl.syncGroups) {
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
          const current =
            await KbExternalUserGroupModel.findMembershipSnapshotByConnector(
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
          let pending: InsertKbExternalUserGroup[] = [];
          for await (const group of connectorImpl.syncGroups({
            config: connector.config as Record<string, unknown>,
            credentials,
            cursor: null,
            readIngestedDocuments,
            refreshIdentities,
          })) {
            groupsEnumerated += 1;
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
              await KbExternalUserGroupModel.upsertMany(pending);
              membershipsPersisted += pending.length;
              pending = [];
              await yieldToEventLoop();
            }
          }
          if (pending.length > 0) {
            await KbExternalUserGroupModel.upsertMany(pending);
            membershipsPersisted += pending.length;
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
            membershipsRemoved += await KbExternalUserGroupModel.deleteByKeys({
              connectorId,
              keys: revoked.slice(i, i + this.batchSize),
            });
            await yieldToEventLoop();
          }
          stats.groupsSynced = groupsEnumerated;
          stats.membershipsUpserted = membershipsPersisted;
          // A removal-only refresh (someone lost access upstream) must not
          // read as "nothing changed" — the removal IS the change.
          stats.membershipsRemoved = membershipsRemoved;
        } catch (error) {
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
        // ---- Audience verification, EVERY delta pass: re-resolve every
        // stored container's audience — O(containers) upstream requests, zero
        // document enumeration — and write only the ones that changed. This
        // is what guarantees an upstream grant OR revocation lands on the
        // next pass: audience drift is never inferred from audit events or
        // cursor windows (both proved lossy — see PermissionProbeResult).
        // Mapping edits materialize the same way, so their follow-up task
        // needs no special flag. ----
        if (connectorImpl.refreshContainerAudiences) {
          await this.refreshStoredContainerAudiences({
            connector,
            connectorImpl,
            credentials,
            resolveMappedEmail,
            stats,
            runLog,
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
          // No document-level drift since the recorded cursors and no
          // documents awaiting adoption. Audiences and group memberships were
          // still verified above — their writes (if any) already landed.
          runLog.info(
            "Delta pass verified audiences and memberships; no document-level drift to re-enumerate",
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
      const message = extractErrorMessage(error);
      // A run that advanced its snapshot cursor is `partial` (checkpoint
      // preserved; a re-enqueued resume picks up from the last completed
      // container, and a partial pass never runs the vanished-container
      // sweep). A run that made NO progress is `failed`: re-running it
      // immediately would hit the same error again, so no continuation is
      // enqueued and the next scheduled pass is the retry.
      const status = snapshotProgressed ? "partial" : "failed";
      runLog.error({ error: message, status }, "Permission sync pass failed");
      await ConnectorRunModel.updateIfOwned({
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
      await KnowledgeBaseConnectorModel.update(connectorId, {
        lastPermissionSyncStatus: status,
      });
      metrics.rag.reportPermissionSync({
        connectorType: connector.connectorType,
        status,
      });
      return { runId, status };
    }
  }

  /**
   * Audience-verification phase, run on every delta pass: re-resolve the
   * audience of every STORED container row through the connector's
   * `refreshContainerAudiences` and write only the rows whose audience
   * actually changed. O(containers) upstream requests and container-row
   * writes; documents and chunks are never touched — they reference the
   * container by token. Keys the connector does not yield back (it cannot
   * refresh them without an assignment reconcile) keep their stored audience
   * until the periodic full reconcile.
   */
  private async refreshStoredContainerAudiences(params: {
    connector: KnowledgeBaseConnector;
    connectorImpl: Connector;
    credentials: ConnectorCredentials;
    resolveMappedEmail: ResolveMappedEmail;
    stats: PermissionSyncRunStats;
    runLog: pino.Logger;
  }): Promise<void> {
    const {
      connector,
      connectorImpl,
      credentials,
      resolveMappedEmail,
      stats,
      runLog,
    } = params;
    if (!connectorImpl.refreshContainerAudiences) return;
    const containerKeys = await KbContainerAclModel.findKeysByConnector(
      connector.id,
    );
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
        }));
      pending = [];
    };
    for await (const item of connectorImpl.refreshContainerAudiences({
      config: connector.config as Record<string, unknown>,
      credentials,
      containerKeys,
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
  }): Promise<number> {
    const { connector, batch, clearsStaleMarks, stats, runLog } = params;
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

    await KbContainerAclModel.upsertMany(toWrite);
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
    await ConnectorRunModel.updateIfOwned({
      runId,
      epoch,
      // Stats ride along with every checkpoint so a running pass shows live
      // progress (they are cheap — same fenced UPDATE).
      data: { checkpoint, ...(stats ? { stats: { ...stats } } : {}) },
    });
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
    await this.finalize({
      connectorId: params.connectorId,
      runId: params.runId,
      epoch: params.epoch,
      startedAt: params.startedAt,
      stats: params.stats,
      getLogOutput: params.getLogOutput,
    });
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
  }): Promise<void> {
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
  }
}

export const permissionSyncService = new PermissionSyncService();

// ===== Internal helpers =====

const EMPTY_SOURCE_ID_SET: ReadonlySet<string> = new Set();

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
