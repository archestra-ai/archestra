import { createHash } from "node:crypto";
import { isK8sConfigured } from "@/k8s/shared";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorIdentity,
  ConnectorSyncBatch,
  DocumentPermissions,
  GroupMembershipYield,
  PerforceCheckpoint,
  PerforceConfig,
  PermissionProbeResult,
  PermissionSnapshotYield,
  PermissionSyncParams,
  PermissionSyncState,
  ReadIngestedDocuments,
  ResolveMappedEmail,
} from "@/types";
import { PerforceConfigSchema } from "@/types";
import { BaseConnector } from "../base-connector";
import { type P4WireAddress, p4ServerScope } from "./p4-endpoint";
import {
  type P4GroupSpec,
  type P4ProtectionLine,
  P4ProtectionsEvaluator,
  parseGroupSpecRecord,
  parseProtectsRecords,
} from "./p4-protections";
import {
  isConnectionLevelError,
  P4ApiError,
  type P4DepotFile,
  P4FileTooLargeError,
  P4RestClient,
} from "./p4-rest-client";
import { getP4ShimConnection } from "./p4-shim-service";

/**
 * Knowledge connector for Perforce Helix Core depots.
 *
 * Syncs text files (default: .md/.yaml/.yml, customizable via `fileTypes`)
 * from one or more depot paths through the P4 REST API — see
 * {@link P4RestClient} for the transport details. No `p4` CLI binary and no
 * client workspace are involved.
 *
 * Incremental sync is driven by a changelist-number cursor:
 * - `lastChangelist` is the committed cursor — every submitted change up to
 *   it is fully ingested.
 * - While a sweep is running, `targetChangelist` pins the sweep to a fixed
 *   changelist (so listing and content stay consistent even if users submit
 *   mid-sync) and `filesOffset` records progress through the deterministic,
 *   depot-path-sorted candidate list. The sync pipeline persists the
 *   checkpoint after every batch and resumes partial/time-boxed runs from it,
 *   so an interrupted sweep continues where it stopped instead of restarting.
 *
 * File deletions are not propagated on incremental syncs (the sync pipeline
 * has no delete channel); a force re-sync rebuilds the corpus from scratch.
 *
 * `estimateTotalItems` deliberately stays at the inherited null: producing a
 * count would require the same `/v0/file/revisions` listing the sweep itself
 * performs. The client also deliberately has no retry layer — transient
 * per-file download failures are recorded on the run, and listing/auth
 * failures surface loudly.
 */
export class PerforceConnector extends BaseConnector {
  type = "perforce" as const;

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Permission sync needs the in-cluster p4 shim (`k8s/p4-shim-runtime`) —
   * the P4 REST API exposes no users/groups/protections — so the capability
   * exists only where the Kubernetes orchestrator is configured. Evaluated at
   * construction; the orchestrator configuration is static for the process
   * lifetime.
   */
  supportsPermissionSync = isK8sConfigured();
  // SPDX-SnippetEnd

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.validateConfigWithSchema({
      config,
      parser: parsePerforceConfig,
      label: "Perforce",
      invalidConfigError:
        'Invalid Perforce configuration: serverUrl (the P4 REST API base URL, e.g. "https://perforce.example.com:8080") and at least one depot path ("//depot/path") are required',
    });
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    identity?: ConnectorIdentity;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parsePerforceConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Perforce configuration" };
    }

    return this.runConnectionTest({
      label: "Perforce",
      probe: async () => {
        const client = this.createClient(parsed, params.credentials);
        // Authenticated server probe: surfaces unreachable-URL and
        // login/ticket problems.
        await client.info();
        // Listing probe: surfaces per-path permission problems.
        await client.files([`${parsed.depotPaths[0]}/...`], { max: 1 });
        await this.testPermissionSyncPath(
          parsed,
          params.credentials,
          params.identity,
        );
      },
    });
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parsePerforceConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Perforce configuration");
    }

    const checkpoint = (params.checkpoint as PerforceCheckpoint | null) ?? {
      type: "perforce" as const,
    };
    const client = this.createClient(parsed, params.credentials);

    const sweep = await this.resolveSweep(client, parsed, checkpoint);
    if (!sweep) {
      this.log.info(
        { checkpoint },
        "No new submitted changes, nothing to sync",
      );
      yield {
        documents: [],
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        // Re-persist only the committed cursor fields so malformed in-flight
        // state (e.g. an orphaned filesOffset) is normalized away.
        checkpoint: {
          type: "perforce",
          lastSyncedAt: checkpoint.lastSyncedAt,
          lastChangelist: checkpoint.lastChangelist,
        },
        hasMore: false,
      };
      return;
    }
    const { target, targetTime, isResume } = sweep;

    const files = await this.listCandidateFiles({
      client,
      config: parsed,
      checkpoint,
      target,
      isResume,
    });
    // Only honor the offset when it belongs to this sweep — an orphaned
    // filesOffset (no targetChangelist) must not skip files of a fresh sweep.
    const startOffset = isResume ? (checkpoint.filesOffset ?? 0) : 0;

    this.log.info(
      {
        target,
        fromChangelist: checkpoint.lastChangelist,
        candidateFiles: files.length,
        startOffset,
      },
      "Starting Perforce sweep",
    );

    const committedCheckpoint: PerforceCheckpoint = {
      type: "perforce",
      lastSyncedAt: targetTime ?? checkpoint.lastSyncedAt,
      lastChangelist: target,
    };

    if (startOffset >= files.length) {
      yield {
        documents: [],
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        checkpoint: committedCheckpoint,
        hasMore: false,
      };
      return;
    }

    for (let i = startOffset; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const documents: ConnectorDocument[] = [];

      for (const file of batch) {
        await this.rateLimit();
        const content = await this.fetchFileContent(client, file, target);
        if (content !== null) {
          documents.push(depotFileToDocument(file, content, target, parsed));
        }
      }

      const nextOffset = Math.min(i + BATCH_SIZE, files.length);
      const isLastBatch = nextOffset >= files.length;

      this.log.info(
        {
          target,
          batchStart: i,
          documentsIndexed: documents.length,
          remainingFiles: files.length - nextOffset,
        },
        "Perforce batch completed",
      );

      yield {
        documents,
        failures: this.flushFailures(),
        skipped: this.flushSkipped(),
        checkpoint: isLastBatch
          ? committedCheckpoint
          : {
              type: "perforce",
              lastSyncedAt: checkpoint.lastSyncedAt,
              lastChangelist: checkpoint.lastChangelist,
              targetChangelist: target,
              targetChangeTime: targetTime,
              filesOffset: nextOffset,
            },
        hasMore: !isLastBatch,
      };
    }
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

  /**
   * Container model: each configured depot path is a top-level container
   * (`depot://depot/docs`, an audience-less anchor for delta scoping), and
   * documents land in nested containers keyed by their protection SIGNATURE —
   * the exact table lines matching their path (`depot://depot/docs/acl:<hash>`).
   * Documents sharing a signature share an audience by construction, so
   * audiences are computed once per signature, not per document, and an
   * unrelated table edit does not move documents between containers (the hash
   * is content-derived).
   *
   * Audiences are per-USER emails: raw group tokens would over-grant the
   * moment an exclusion line carves a member out of a granted group, so the
   * evaluator resolves effective read access per user (admin member mappings
   * take precedence over upstream emails; a user with neither is dropped
   * fail-closed and surfaced via the group roster).
   */
  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const context = await this.loadPermissionContext(params);
    const buckets = await this.bucketIngestedDocuments(
      context,
      params.readIngestedDocuments,
    );
    const scope = params.scope ? new Set(params.scope.containerKeys) : null;

    for (const topKey of [...buckets.keys()].sort()) {
      if (scope && !scope.has(topKey)) continue;
      // Resume: containers strictly before the cursor are done; the cursor
      // container is re-enumerated (idempotent — same audiences).
      if (params.cursor && topKey < params.cursor) continue;

      // Audience-less anchor: no document is assigned directly to it, its
      // nested signature containers carry the real audiences.
      yield {
        kind: "container",
        containerKey: topKey,
        permissions: {},
        cursor: topKey,
      };

      const signatures = buckets.get(topKey) ?? new Map();
      for (const signatureKey of [...signatures.keys()].sort()) {
        const bucket = signatures.get(signatureKey);
        if (!bucket) continue;
        yield {
          kind: "container",
          containerKey: `${topKey}/acl:${signatureKey}`,
          permissions: this.resolveAudience(context, bucket.signature),
          fingerprint: signatureKey,
          cursor: topKey,
        };
        for (const sourceId of bucket.sourceIds.sort()) {
          yield {
            kind: "document",
            sourceId,
            containerKey: `${topKey}/acl:${signatureKey}`,
            cursor: topKey,
          };
        }
      }
    }

    this.reportDroppedPrincipals(context);
  }

  /**
   * Roster: every real Perforce group (members expanded transitively through
   * subgroups, matching how protections evaluate) plus a synthetic all-users
   * group, so every account is visible and override-mappable in the
   * Permissions tab. Group ids are server-scoped (`p4group:<server>:<name>`):
   * group ACL tokens embed only the connector type, so a bare name would
   * collide across two Perforce servers. The roster is admin-facing only —
   * container audiences are per-user emails, never group tokens.
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const context = await this.loadPermissionContext(params);
    const scope = p4ServerScope(context.address);

    const memberFor = (
      username: string,
    ): {
      accountId: string;
      displayName: string | null;
      email: string | null;
      accountType: string;
    } => {
      const user = context.usersByName.get(username);
      return {
        accountId: username,
        displayName: user?.fullName ?? null,
        email: user?.email ?? null,
        accountType: "user",
      };
    };

    for (const group of [...context.groups].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const members = [...this.expandGroupMembers(context, group.name)].sort();
      yield {
        groupId: `p4group:${scope}:${group.name}`,
        name: group.name,
        members: members.map(memberFor),
      };
    }

    yield {
      groupId: `p4users:${scope}`,
      name: "All Perforce users",
      members: [...context.usersByName.keys()].sort().map(memberFor),
    };

    this.reportDroppedPrincipals(context);
  }

  /**
   * Delta probe: one fingerprint over the protections table, group specs, and
   * user roster. Any drift promotes to a full reconcile — a table edit can
   * repartition documents between signature containers, so scoping a delta
   * tighter than "everything" would have to re-derive the partition anyway,
   * which IS the full pass. The three reads behind the fingerprint are a
   * handful of shim commands, so the probe stays cheap; content-driven
   * document changes are handled by `scopeKeyForDocument` adoption.
   */
  async probePermissionChanges(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    identity?: ConnectorIdentity;
    state: PermissionSyncState | null;
  }): Promise<PermissionProbeResult> {
    const context = await this.loadPermissionContext(params);
    const nextState = { fingerprint: context.fingerprint };
    const previous =
      typeof params.state?.fingerprint === "string"
        ? params.state.fingerprint
        : null;
    if (!previous || previous !== context.fingerprint) {
      return { dirtyContainerKeys: [], fullRequired: true, nextState };
    }
    return { dirtyContainerKeys: [], fullRequired: false, nextState };
  }

  /**
   * Audience verification on every delta pass: recompute each stored
   * signature container's audience from fresh table+roster reads. A stored
   * key whose signature no longer exists is not yielded — its row stays for
   * the full reconcile the probe will have demanded (any upstream drift
   * changes the fingerprint, so in practice this re-verifies unchanged
   * audiences).
   */
  async *refreshContainerAudiences(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    identity?: ConnectorIdentity;
    containerKeys: string[];
    readIngestedDocuments: ReadIngestedDocuments;
    resolveMappedEmail?: ResolveMappedEmail;
  }): AsyncGenerator<{
    containerKey: string;
    permissions: DocumentPermissions;
    fingerprint?: string | null;
    audienceResolutionFailed?: boolean;
  }> {
    const context = await this.loadPermissionContext(params);
    const buckets = await this.bucketIngestedDocuments(
      context,
      params.readIngestedDocuments,
    );
    const bySignatureKey = new Map<string, { signature: P4ProtectionLine[] }>();
    for (const signatures of buckets.values()) {
      for (const [signatureKey, bucket] of signatures) {
        bySignatureKey.set(signatureKey, bucket);
      }
    }

    for (const containerKey of params.containerKeys) {
      const nested = /\/acl:([0-9a-f]+)$/.exec(containerKey);
      if (!nested) {
        // Top-level anchors keep their empty audience.
        if (buckets.has(containerKey)) {
          yield { containerKey, permissions: {} };
        }
        continue;
      }
      const bucket = bySignatureKey.get(nested[1]);
      if (!bucket) continue;
      yield {
        containerKey,
        permissions: this.resolveAudience(context, bucket.signature),
        fingerprint: nested[1],
      };
    }

    this.reportDroppedPrincipals(context);
  }

  /**
   * Delta-pass adoption scoping: content sync stamps `depotRoot` (the
   * configured depot path covering the file) on every document. Scoping only
   * — assignment comes from the snapshot enumeration, so a stale value can
   * delay adoption but never over-grant.
   */
  scopeKeyForDocument(metadata: Record<string, unknown>): string | null {
    const depotRoot = metadata.depotRoot;
    if (typeof depotRoot === "string" && depotRoot.length > 0) {
      return `depot:${depotRoot}`;
    }
    return null;
  }
  // SPDX-SnippetEnd

  // ===== Private methods =====

  private createClient(
    config: PerforceConfig,
    credentials: ConnectorCredentials,
  ): P4RestClient {
    const username = credentials.email?.trim() ?? "";
    if (!username) {
      // Enforced at runtime (not only in the UI) because connectors can also
      // be created through the API and MCP tools.
      throw new P4ApiError(
        "Perforce connector requires a username (stored in the credential email field)",
        { connectionLevel: true },
      );
    }
    return new P4RestClient({
      serverUrl: config.serverUrl,
      username,
      ticket: credentials.apiToken,
      log: this.log,
    });
  }

  /**
   * Determine the changelist this run sweeps to. Resumes an in-flight sweep
   * when the checkpoint carries one; otherwise asks the server for the latest
   * submitted change across the configured depot paths. Returns null when
   * there is nothing new to sync.
   */
  private async resolveSweep(
    client: P4RestClient,
    config: PerforceConfig,
    checkpoint: PerforceCheckpoint,
  ): Promise<{
    target: number;
    targetTime?: string;
    isResume: boolean;
  } | null> {
    if (checkpoint.targetChangelist !== undefined) {
      this.log.info(
        {
          target: checkpoint.targetChangelist,
          filesOffset: checkpoint.filesOffset,
        },
        "Resuming interrupted Perforce sweep",
      );
      return {
        target: checkpoint.targetChangelist,
        targetTime: checkpoint.targetChangeTime,
        isResume: true,
      };
    }

    let latest: { change: number; time?: string } | null = null;
    for (const depotPath of config.depotPaths) {
      const change = await client.latestChange(`${depotPath}/...`);
      if (change && (!latest || change.change > latest.change)) {
        latest = change;
      }
    }

    if (
      !latest ||
      (checkpoint.lastChangelist !== undefined &&
        latest.change <= checkpoint.lastChangelist)
    ) {
      return null;
    }
    return { target: latest.change, targetTime: latest.time, isResume: false };
  }

  /**
   * Deterministic candidate list for the sweep, pinned to `@target`:
   * extension-filtered server-side via `//path/....<ext>` filespecs, restricted
   * to the `@lastChangelist+1,@target` window on incremental runs, reduced to
   * downloadable text filetypes, filtered against `excludePaths`, deduped, and
   * sorted by depot path so `filesOffset` resumes are stable.
   */
  private async listCandidateFiles(params: {
    client: P4RestClient;
    config: PerforceConfig;
    checkpoint: PerforceCheckpoint;
    target: number;
    isResume: boolean;
  }): Promise<P4DepotFile[]> {
    const { client, config, checkpoint, target, isResume } = params;
    const revisionRange =
      checkpoint.lastChangelist === undefined
        ? `@${target}`
        : `@${checkpoint.lastChangelist + 1},@${target}`;

    const filespecs: string[] = [];
    for (const depotPath of config.depotPaths) {
      for (const extension of getIndexedExtensions(config)) {
        filespecs.push(`${depotPath}/...${extension}${revisionRange}`);
      }
    }

    // One listing request per filespec so each response stays within the
    // per-request size/timeout caps — a combined listing of a large depot's
    // initial sweep could exceed them and fail the run on every retry.
    const byDepotFile = new Map<string, P4DepotFile>();
    const skippedNonText = new Map<string, string>();
    for (const filespec of filespecs) {
      for (const file of await client.files([filespec])) {
        if (isExcluded(file.depotFile, config.excludePaths)) continue;
        if (!isTextFileType(file.type)) {
          skippedNonText.set(file.depotFile, file.type);
          continue;
        }
        const existing = byDepotFile.get(file.depotFile);
        if (!existing || file.rev > existing.rev) {
          byDepotFile.set(file.depotFile, file);
        }
      }
    }

    // Resumed continuations rebuild the same candidate list; only the fresh
    // sweep reports the skips so they are not double-counted. Deduped by
    // depot file so overlapping depot paths report each skip once.
    if (!isResume) {
      for (const [depotFile, fileType] of skippedNonText) {
        this.trackSkipped({
          itemId: depotFile,
          name: depotFile,
          reason: `unsupported Perforce filetype "${fileType}"`,
          category: "unsupported_type",
        });
      }
    }

    // Sorted by depot path so `filesOffset` resumes are stable. The offset
    // assumes the pinned listing is immutable; an admin `p4 obliterate` or
    // rename mid-sweep can shift it, which heals on the next sweep when the
    // cursor advances.
    return [...byDepotFile.values()].sort((a, b) =>
      a.depotFile < b.depotFile ? -1 : a.depotFile > b.depotFile ? 1 : 0,
    );
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

  /**
   * Test-connection leg for permission sync: reconcile the shim, verify the
   * derived wire address by probing it from inside the pod, authenticate the
   * admin user, and read the protections table — which is the operation that
   * actually needs super access (or admin with `dm.protects.allow.admin=1`).
   *
   * Without this leg the permission-sync configuration is asserted and never
   * checked: a Perforce server whose wire address is not its REST host, or an
   * admin user without the rights to read protections, both pass Test
   * Connection and fail only at the first permission pass.
   *
   * Skipped for content-only connectors, which carry no admin credentials and
   * must not pay for the shim.
   */
  private async testPermissionSyncPath(
    config: PerforceConfig,
    credentials: ConnectorCredentials,
    identity: ConnectorIdentity | undefined,
  ): Promise<void> {
    const password = credentials.adminApiKey?.trim();
    if (!this.supportsPermissionSync || !config.adminUsername || !password) {
      return;
    }
    const { client, address } = await getP4ShimConnection({
      identity: requireIdentity(identity),
      serverUrl: config.serverUrl,
      p4Port: config.p4Port,
      username: config.adminUsername,
      password,
      log: this.log,
    });
    await client.info();
    await client.protectsAll();
    this.log.info(
      { host: address.host, port: address.port },
      "Verified the Perforce permission-sync endpoint and admin access",
    );
  }

  /**
   * One-per-pass upstream read: protections table, group specs, and user
   * roster through the p4 shim, compiled into the evaluator plus a drift
   * fingerprint. Every permission hook starts here; a failure aborts the pass
   * loudly (fail-closed) instead of degrading into a partial audience.
   */
  private async loadPermissionContext(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    identity?: ConnectorIdentity;
    resolveMappedEmail?: ResolveMappedEmail;
  }): Promise<P4PermissionContext> {
    const parsed = parsePerforceConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Perforce configuration for permission sync");
    }
    if (!parsed.adminUsername) {
      throw new Error(
        "Perforce permission sync requires adminUsername in the connector configuration",
      );
    }
    const password = params.credentials.adminApiKey?.trim();
    if (!password) {
      throw new Error(
        "Perforce permission sync requires the admin password (stored in the adminApiKey credential field)",
      );
    }

    const { client, address } = await getP4ShimConnection({
      identity: requireIdentity(params.identity),
      serverUrl: parsed.serverUrl,
      p4Port: parsed.p4Port,
      username: parsed.adminUsername,
      password,
      log: this.log,
    });
    const info = await client.info();
    const caseInsensitive =
      String(info.caseHandling ?? "sensitive") === "insensitive";
    const lines = parseProtectsRecords(await client.protectsAll());
    const groups: P4GroupSpec[] = [];
    // Tagged `p4 groups` emits one record per membership row, so a group
    // appears once per member — dedupe before expanding specs.
    for (const name of [...new Set(await client.listGroups())].sort()) {
      groups.push(parseGroupSpecRecord(await client.groupSpec(name)));
    }
    const usersByName = new Map<
      string,
      { email: string | null; fullName: string | null }
    >();
    for (const record of await client.listUsers()) {
      const username = typeof record.User === "string" ? record.User : "";
      if (!username) continue;
      usersByName.set(username, {
        email:
          typeof record.Email === "string" && record.Email
            ? record.Email
            : null,
        fullName:
          typeof record.FullName === "string" && record.FullName
            ? record.FullName
            : null,
      });
    }

    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          lines,
          groups,
          users: [...usersByName.entries()]
            .map(([name, user]) => [name, user.email])
            .sort(),
          caseInsensitive,
        }),
      )
      .digest("hex");

    return {
      address,
      depotPaths: parsed.depotPaths,
      evaluator: new P4ProtectionsEvaluator({ lines, groups, caseInsensitive }),
      groups,
      usersByName,
      fingerprint,
      resolveMappedEmail: params.resolveMappedEmail,
      dropped: new Set(),
    };
  }

  /**
   * Page the connector's ingested documents (content-sync output) and bucket
   * them: configured depot path → protection signature → source ids. Holds
   * every source id in memory for the pass — knowledge-base corpora are
   * bounded (the same trade the sibling connectors make), and the signature
   * grouping is what keeps audience computation O(signatures), not
   * O(documents).
   */
  private async bucketIngestedDocuments(
    context: P4PermissionContext,
    readIngestedDocuments: ReadIngestedDocuments,
  ): Promise<P4DocumentBuckets> {
    const buckets: P4DocumentBuckets = new Map();
    for (const path of context.depotPaths) {
      buckets.set(`depot:${path}`, new Map());
    }
    let afterId: string | null = null;
    do {
      const page = await readIngestedDocuments({ afterId, limit: 500 });
      for (const doc of page.documents) {
        const depotPath = doc.metadata?.depotPath;
        if (typeof depotPath !== "string" || !depotPath) continue;
        const root = containerPathForDepotFile(depotPath, context.depotPaths);
        if (!root) continue;
        const signature = context.evaluator.matchingLines(depotPath);
        const signatureKey = context.evaluator.signatureKey(signature);
        const signatures = buckets.get(`depot:${root}`);
        if (!signatures) continue;
        let bucket = signatures.get(signatureKey);
        if (!bucket) {
          bucket = { signature, sourceIds: [] };
          signatures.set(signatureKey, bucket);
        }
        bucket.sourceIds.push(doc.sourceId);
      }
      afterId = page.nextAfterId;
    } while (afterId);
    return buckets;
  }

  /**
   * Signature → audience: every rostered user the evaluator grants read,
   * materialized as an email (admin member mapping first, upstream email
   * second; neither → dropped fail-closed and reported).
   */
  private resolveAudience(
    context: P4PermissionContext,
    signature: P4ProtectionLine[],
  ): DocumentPermissions {
    const emails = new Set<string>();
    const usernames = context.evaluator.audience(
      [...context.usersByName.keys()],
      signature,
    );
    for (const username of usernames) {
      const email =
        context.resolveMappedEmail?.(username) ??
        context.usersByName.get(username)?.email;
      if (email) {
        emails.add(email);
      } else {
        context.dropped.add(username);
      }
    }
    return { users: [...emails].sort(), groups: [], isPublic: false };
  }

  /** Transitive members of one group (subgroups expanded, owners excluded). */
  private expandGroupMembers(
    context: P4PermissionContext,
    groupName: string,
    visiting: Set<string> = new Set(),
  ): Set<string> {
    const members = new Set<string>();
    if (visiting.has(groupName)) return members;
    visiting.add(groupName);
    const spec = context.groups.find((group) => group.name === groupName);
    if (!spec) return members;
    for (const user of spec.users) members.add(user);
    for (const subgroup of spec.subgroups) {
      for (const user of this.expandGroupMembers(context, subgroup, visiting)) {
        members.add(user);
      }
    }
    return members;
  }

  private reportDroppedPrincipals(context: P4PermissionContext): void {
    if (context.dropped.size === 0) return;
    this.log.warn(
      {
        count: context.dropped.size,
        sample: [...context.dropped].slice(0, 10),
      },
      "Perforce users without a resolvable email were dropped from audiences (fail-closed); map them via member overrides",
    );
  }
  // SPDX-SnippetEnd

  /**
   * Download one file at the sweep target. Oversized files are skipped,
   * connection/auth breakage aborts the run, anything else (e.g. per-file
   * permission errors) is recorded as an item failure and the sweep continues.
   */
  private async fetchFileContent(
    client: P4RestClient,
    file: P4DepotFile,
    target: number,
  ): Promise<string | null> {
    try {
      return await client.readFile(`${file.depotFile}@${target}`);
    } catch (error) {
      if (error instanceof P4FileTooLargeError) {
        this.trackSkipped({
          itemId: file.depotFile,
          name: file.depotFile,
          reason: error.message,
        });
        return null;
      }
      if (isConnectionLevelError(error)) {
        throw error;
      }
      return this.safeItemFetch({
        fetch: async () => {
          throw error;
        },
        fallback: null,
        itemId: file.depotFile,
        resource: "file_content",
        itemUnavailable: true,
      });
    }
  }
}

// ===== Module-level helpers =====

const BATCH_SIZE = 50;

const DEFAULT_FILE_EXTENSIONS = [".md", ".yaml", ".yml"];

function parsePerforceConfig(
  config: Record<string, unknown>,
): PerforceConfig | null {
  const result = PerforceConfigSchema.safeParse(config);
  return result.success ? result.data : null;
}

function getIndexedExtensions(config: PerforceConfig): string[] {
  const extensions =
    config.fileTypes && config.fileTypes.length > 0
      ? config.fileTypes
      : DEFAULT_FILE_EXTENSIONS;

  return extensions
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
}

/**
 * Whether a depot file falls under one of the configured exclude paths.
 * Prefix match on path-segment boundaries: `//depot/docs/gen` excludes
 * `//depot/docs/gen/a.md` but not `//depot/docs/gen-notes/a.md`.
 */
function isExcluded(
  depotFile: string,
  excludePaths: string[] | undefined,
): boolean {
  if (!excludePaths || excludePaths.length === 0) return false;
  return excludePaths.some((prefix) => depotFile.startsWith(`${prefix}/`));
}

/**
 * Whether a Perforce filetype holds printable text. Matches the `text`,
 * `unicode`, and `utf8` base types plus their old-style aliases (ktext,
 * xltext, xunicode, …); excludes binary, symlink, apple, resource, tempobj,
 * and utf16. Modifiers after `+` are irrelevant to printability.
 */
function isTextFileType(fileType: string): boolean {
  const baseType = fileType.split("+")[0].toLowerCase();
  return /text|unicode|utf8/.test(baseType);
}

function depotFileToDocument(
  file: P4DepotFile,
  content: string,
  changelist: number,
  config: PerforceConfig,
): ConnectorDocument {
  const segments = file.depotFile.split("/");
  const fileName = segments.pop() ?? file.depotFile;
  const depotRoot = containerPathForDepotFile(
    file.depotFile,
    config.depotPaths,
  );
  return {
    // The depot path is stable across revisions, so re-syncs update the same
    // document instead of accumulating duplicates.
    id: file.depotFile,
    title: `${fileName} (${segments.join("/")})`,
    content,
    metadata: {
      depotPath: file.depotFile,
      rev: file.rev,
      changelist,
      perforceFileType: file.type,
      kind: "depot_file",
      // Permission sync's delta-adoption scope (scopeKeyForDocument).
      ...(depotRoot ? { depotRoot } : {}),
    },
    // Bookkeeping only: a config edit that re-roots a file must not force
    // re-chunking of unchanged content.
    operationalMetadataKeys: ["depotRoot"],
  };
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

/**
 * The configured depot path covering a depot file (longest wins on nesting),
 * matching on path-segment boundaries; null when no configured path covers it
 * (config narrowed since ingest).
 */
function containerPathForDepotFile(
  depotFile: string,
  depotPaths: string[],
): string | null {
  let best: string | null = null;
  for (const path of depotPaths) {
    if (!depotFile.startsWith(`${path}/`)) continue;
    if (!best || path.length > best.length) best = path;
  }
  return best;
}

/**
 * Fail closed on a missing identity: without it the shim scope is unknown, and
 * defaulting to a shared one would put this connector's Perforce credentials
 * through another connector's pod.
 */
function requireIdentity(
  identity: ConnectorIdentity | undefined,
): ConnectorIdentity {
  if (!identity) {
    throw new Error(
      "Perforce permission sync requires the connector's identity",
    );
  }
  return identity;
}

interface P4PermissionContext {
  /** The verified wire address of the Perforce server (see `p4-endpoint`). */
  address: P4WireAddress;
  depotPaths: string[];
  evaluator: P4ProtectionsEvaluator;
  groups: P4GroupSpec[];
  usersByName: Map<string, { email: string | null; fullName: string | null }>;
  fingerprint: string;
  resolveMappedEmail?: ResolveMappedEmail;
  /** Usernames granted access upstream but unmaterializable (no email, no mapping). */
  dropped: Set<string>;
}

/** top-level container key → signature key → the signature and its documents. */
type P4DocumentBuckets = Map<
  string,
  Map<string, { signature: P4ProtectionLine[]; sourceIds: string[] }>
>;
// SPDX-SnippetEnd
