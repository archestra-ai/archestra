// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

//
// Correctness tests for the connector-agnostic permission-sync pass
// (permissionSyncService.executePass), driven against a REAL database with a
// FAKE connector impl injected via the connector registry so the pass's
// container/epoch/resume/group machinery can be exercised precisely without a
// specific upstream. (The GitHub end-to-end path is covered separately in
// permission-sync.integration.test.ts.)
import { vi } from "vitest";
import type { DocumentPermissions } from "@/types";

const { getConnector } = vi.hoisted(() => ({ getConnector: vi.fn() }));
vi.mock("@/knowledge-base/connectors/registry", () => ({ getConnector }));
vi.mock("@/knowledge-base/connector-credentials", () => ({
  resolveConnectorCredentials: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/cache-manager");

import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { buildContainerToken } from "@/knowledge-base/acl-tokens";
import { findAccessTokensForUserCached } from "@/knowledge-base/group-token-cache";
import { permissionSyncService } from "@/knowledge-base/permission-sync";
import { ConnectorRunModel, KbExternalUserGroupModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";

type FakeContainer = {
  containerKey: string;
  permissions?: DocumentPermissions;
  documents?: { sourceId: string; exceptionUsers?: string[] }[];
  /** The connector could not READ the permissions — fail-closed, not observed. */
  audienceResolutionFailed?: boolean;
};

/**
 * A programmable connector impl. `syncPermissionSnapshot` honors the resume
 * cursor per the contract (top-level containers strictly below the cursor are
 * skipped; the cursor container is re-enumerated) so resume tests can assert
 * tail-only processing.
 */
function makeFakeConnector(opts: {
  containers?: FakeContainer[];
  groups?: { groupId: string; memberEmails: string[] }[];
  hasSyncGroups?: boolean;
  syncGroupsThrows?: boolean;
  /** Crash after this many DOCUMENT yields (containers don't count). */
  throwAfterDocs?: number;
  onStart?: () => Promise<void>;
  /** Wire a probe hook (delta-mode tests). */
  probe?: {
    dirtyContainerKeys: string[];
    fullRequired?: boolean;
    nextState?: Record<string, unknown>;
  };
  /** Wire the local-adoption metadata→scope mapping (delta-mode tests). */
  scopeKeyForDocument?: (metadata: Record<string, unknown>) => string | null;
  /**
   * Wire the audience-refresh hook: stored container key → its re-resolved
   * audience. Keys absent from the map are skipped (connector cannot refresh
   * them), mirroring the real hooks. When a probe is wired and this is
   * absent, a yield-nothing hook is installed by default — delta mode
   * REQUIRES the hook (a probe-capable connector without it runs full-only).
   */
  refreshAudiences?: Record<string, DocumentPermissions>;
  /** Omit the refresh hook entirely (full-only-promotion tests). */
  withoutRefreshHook?: boolean;
}) {
  // biome-ignore lint/suspicious/noExplicitAny: test double
  const impl: any = {
    supportsPermissionSync: true,
    async *syncPermissionSnapshot(params: {
      cursor: string | null;
      scope?: { containerKeys: string[] };
    }) {
      if (opts.onStart) await opts.onStart();
      const scope = params.scope ? new Set(params.scope.containerKeys) : null;
      let docsYielded = 0;
      for (const container of opts.containers ?? []) {
        if (scope && !scope.has(container.containerKey)) continue;
        if (params.cursor !== null && container.containerKey < params.cursor) {
          continue;
        }
        yield {
          kind: "container" as const,
          containerKey: container.containerKey,
          permissions: container.permissions ?? {},
          ...(container.audienceResolutionFailed
            ? { audienceResolutionFailed: true }
            : {}),
          cursor: container.containerKey,
        };
        for (const doc of container.documents ?? []) {
          if (
            opts.throwAfterDocs !== undefined &&
            docsYielded >= opts.throwAfterDocs
          ) {
            throw new Error("simulated crash");
          }
          yield {
            kind: "document" as const,
            sourceId: doc.sourceId,
            containerKey: container.containerKey,
            ...(doc.exceptionUsers
              ? { exceptionUsers: doc.exceptionUsers }
              : {}),
            cursor: container.containerKey,
          };
          docsYielded++;
        }
      }
    },
  };
  if (opts.scopeKeyForDocument) {
    impl.scopeKeyForDocument = opts.scopeKeyForDocument;
  }
  if (opts.refreshAudiences) {
    const refreshAudiences = opts.refreshAudiences;
    impl.refreshContainerAudiences = async function* (params: {
      containerKeys: string[];
    }) {
      for (const containerKey of params.containerKeys) {
        const permissions = refreshAudiences[containerKey];
        if (permissions) yield { containerKey, permissions };
      }
    };
  } else if (opts.probe && !opts.withoutRefreshHook) {
    // Connector "cannot refresh" any stored key: every key skipped.
    impl.refreshContainerAudiences = async function* () {
      // yields nothing
    };
  }
  if (opts.probe) {
    const probe = opts.probe;
    impl.probePermissionChanges = vi.fn().mockResolvedValue({
      dirtyContainerKeys: probe.dirtyContainerKeys,
      fullRequired: probe.fullRequired ?? false,
      nextState: probe.nextState ?? { cursor: "next" },
    });
  }
  if (opts.hasSyncGroups || opts.groups || opts.syncGroupsThrows) {
    impl.syncGroups = async function* () {
      if (opts.syncGroupsThrows) throw new Error("group crash");
      for (const group of opts.groups ?? []) {
        // Test API stays email-shaped; the pass consumes full principals.
        yield {
          groupId: group.groupId,
          members: group.memberEmails.map((email) => ({
            accountId: email,
            displayName: null,
            email,
          })),
        };
      }
    };
  }
  return impl;
}

describe("permission-sync pass (containers / epoch / resume / groups)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // One doc per flush so per-batch behavior (checkpoint, partial) is exact.
    permissionSyncService.batchSize = 1;
  });

  async function seedConnector(organizationId: string) {
    const [kb] = await db
      .insert(schema.knowledgeBasesTable)
      .values({ organizationId, name: "KB" })
      .returning();
    const [connector] = await db
      .insert(schema.knowledgeBaseConnectorsTable)
      .values({
        organizationId,
        name: "auto-sync",
        connectorType: "github",
        visibility: "auto-sync-permissions",
        config: {
          type: "github",
          githubUrl: "https://api.github.com",
          owner: "o",
          repos: ["r"],
        },
      })
      .returning();
    await db.insert(schema.knowledgeBaseConnectorAssignmentsTable).values({
      connectorId: connector.id,
      knowledgeBaseId: kb.id,
    });
    return connector;
  }

  async function seedDoc(params: {
    organizationId: string;
    connectorId: string;
    sourceId: string;
    acl: string[];
    containerKey?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    const [doc] = await db
      .insert(schema.kbDocumentsTable)
      .values({
        organizationId: params.organizationId,
        connectorId: params.connectorId,
        sourceId: params.sourceId,
        title: params.sourceId,
        content: "body",
        contentHash: `hash-${params.sourceId}`,
        acl: params.acl,
        containerKey: params.containerKey ?? null,
        ...(params.metadata ? { metadata: params.metadata } : {}),
        embeddingStatus: "completed",
      })
      .returning();
    await db.insert(schema.kbChunksTable).values({
      documentId: doc.id,
      content: "body",
      chunkIndex: 0,
      acl: params.acl,
    });
    return doc;
  }

  const docRow = async (id: string) =>
    (
      await db
        .select()
        .from(schema.kbDocumentsTable)
        .where(eq(schema.kbDocumentsTable.id, id))
    )[0];

  const docAcl = async (id: string) => (await docRow(id))?.acl;

  const chunkAcl = async (documentId: string) =>
    (
      await db
        .select({ acl: schema.kbChunksTable.acl })
        .from(schema.kbChunksTable)
        .where(eq(schema.kbChunksTable.documentId, documentId))
    )[0]?.acl;

  const containerRow = async (connectorId: string, containerKey: string) =>
    (
      await db
        .select()
        .from(schema.kbContainerAclsTable)
        .where(
          and(
            eq(schema.kbContainerAclsTable.connectorId, connectorId),
            eq(schema.kbContainerAclsTable.containerKey, containerKey),
          ),
        )
    )[0];

  const runCheckpoint = async (runId: string) =>
    (
      await db
        .select({ checkpoint: schema.connectorRunsTable.checkpoint })
        .from(schema.connectorRunsTable)
        .where(eq(schema.connectorRunsTable.id, runId))
    )[0]?.checkpoint as { cursor: string | null } | null | undefined;

  const runStats = async (runId: string) =>
    (
      await db
        .select({ stats: schema.connectorRunsTable.stats })
        .from(schema.connectorRunsTable)
        .where(eq(schema.connectorRunsTable.id, runId))
    )[0]?.stats;

  test("persists family-relevant run stats (containers/adopted/fail-closed/groups) on the run row", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    // B exists but is no longer visible upstream (never assigned) → swept
    // fail-closed by the unassigned sweep.
    await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "b",
      acl: ["user_email:old@example.com"],
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "repo:o/r",
            permissions: { users: ["alice@example.com"] },
            documents: [{ sourceId: "a" }],
          },
        ],
        groups: [
          {
            groupId: "g1",
            memberEmails: ["alice@example.com", "bob@example.com"],
          },
        ],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");
    // The doc carries only its container token; the audience lives on the row.
    const token = buildContainerToken({
      connectorId: connector.id,
      containerKey: "repo:o/r",
    });
    expect(await docAcl(a.id)).toEqual([token]);
    expect((await containerRow(connector.id, "repo:o/r"))?.acl).toEqual([
      "user_email:alice@example.com",
    ]);

    expect(await runStats(result.runId)).toEqual({
      mode: "full",
      totalDocs: 2,
      docsScanned: 1,
      aclsChanged: 1,
      chunksRewritten: 1,
      failClosed: 1,
      groupsSynced: 1,
      membershipsUpserted: 2,
      membershipsRemoved: 0,
      containersSynced: 1,
      containersChanged: 1,
      docsAdopted: 1,
      docsReassigned: 0,
      contentSyncActiveDuringRun: false,
    });
  });

  test("stats flag contentSyncActiveDuringRun when a content run overlaps the pass", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    // Simulate a live content backfill: a `content` run holding its lease.
    const claim = await ConnectorRunModel.claim({
      connectorId: connector.id,
      owner: "content-worker",
      leaseTtlSeconds: 300,
      runType: "content",
    });
    expect(claim.outcome).toBe("claimed");

    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "repo:o/r",
            permissions: { users: ["alice@example.com"] },
            documents: [{ sourceId: "a" }],
          },
        ],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");
    // The badge signal: this success only covered what was ingested so far.
    expect((await runStats(result.runId))?.contentSyncActiveDuringRun).toBe(
      true,
    );
  });

  test("a container audience change is ONE row write — zero document/chunk writes", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    const container = (audience: string[]): FakeContainer => ({
      containerKey: "repo:o/r",
      permissions: { users: audience },
      documents: [{ sourceId: "a" }],
    });

    // Pass 1 adopts the doc into its container.
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [container(["alice@example.com", "bob@example.com"])],
      }),
    );
    const r1 = await permissionSyncService.executePass(connector.id);
    expect(r1.status).toBe("success");
    const token = buildContainerToken({
      connectorId: connector.id,
      containerKey: "repo:o/r",
    });
    expect(await docAcl(a.id)).toEqual([token]);
    expect(await chunkAcl(a.id)).toEqual([token]);
    const adopted = await docRow(a.id);

    // Pass 2: the audience SHRINKS upstream. Only the container row changes.
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({ containers: [container(["alice@example.com"])] }),
    );
    const r2 = await permissionSyncService.executePass(connector.id);
    expect(r2.status).toBe("success");

    expect((await containerRow(connector.id, "repo:o/r"))?.acl).toEqual([
      "user_email:alice@example.com",
    ]);
    const stats = await runStats(r2.runId);
    expect(stats?.containersChanged).toBe(1);
    expect(stats?.aclsChanged).toBe(0);
    expect(stats?.chunksRewritten).toBe(0);
    // The doc row is byte-identical — not even updatedAt moved — and the pass
    // never re-embeds.
    const after = await docRow(a.id);
    expect(after).toEqual(adopted);
    expect(after?.embeddingStatus).toBe("completed");
  });

  test("per-document exception users ride on the doc ACL next to the container token", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "project:P",
            permissions: { groups: ["devs"] },
            documents: [
              { sourceId: "a", exceptionUsers: ["Reporter@Example.com"] },
            ],
          },
        ],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");
    expect(await docAcl(a.id)).toEqual([
      buildContainerToken({
        connectorId: connector.id,
        containerKey: "project:P",
      }),
      // Normalized like every email that crosses the ACL boundary.
      "user_email:reporter@example.com",
    ]);
  });

  test("a document reassigned between containers swaps its token (restriction applied)", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });

    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "space:S",
            permissions: { groups: ["everyone"] },
            documents: [{ sourceId: "a" }],
          },
        ],
      }),
    );
    await permissionSyncService.executePass(connector.id);

    // The page gains a read restriction: same top-level container, nested key.
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "space:S",
            permissions: { groups: ["everyone"] },
            documents: [],
          },
          {
            containerKey: "space:S/page:a",
            permissions: { users: ["alice@example.com"] },
            documents: [{ sourceId: "a" }],
          },
        ],
      }),
    );
    const r2 = await permissionSyncService.executePass(connector.id);
    expect(r2.status).toBe("success");

    expect(await docAcl(a.id)).toEqual([
      buildContainerToken({
        connectorId: connector.id,
        containerKey: "space:S/page:a",
      }),
    ]);
    expect((await runStats(r2.runId))?.docsReassigned).toBe(1);
  });

  test("per-container set-diff fail-closes a doc no longer visible upstream", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const token = buildContainerToken({
      connectorId: connector.id,
      containerKey: "repo:o/r",
    });
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [token],
      containerKey: "repo:o/r",
    });
    // B was previously assigned but is no longer enumerated upstream.
    const b = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "b",
      acl: [token],
      containerKey: "repo:o/r",
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "repo:o/r",
            permissions: { users: ["alice@example.com"] },
            documents: [{ sourceId: "a" }],
          },
        ],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    // A stays; B (absent from the completed enumeration) fail-closes.
    expect(await docAcl(a.id)).toEqual([token]);
    expect(await docAcl(b.id)).toEqual([]);
    expect(await chunkAcl(b.id)).toEqual([]);
  });

  test("a container that vanishes upstream is swept: docs fail-closed, row removed", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });

    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "repo:o/gone",
            permissions: { users: ["alice@example.com"] },
            documents: [{ sourceId: "a" }],
          },
        ],
      }),
    );
    await permissionSyncService.executePass(connector.id);
    expect(await containerRow(connector.id, "repo:o/gone")).toBeDefined();

    // The repo disappears (revoked / deleted): next pass never re-observes it.
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          { containerKey: "repo:o/other", permissions: {}, documents: [] },
        ],
      }),
    );
    const r2 = await permissionSyncService.executePass(connector.id);
    expect(r2.status).toBe("success");

    expect(await docAcl(a.id)).toEqual([]);
    expect(await chunkAcl(a.id)).toEqual([]);
    expect(await containerRow(connector.id, "repo:o/gone")).toBeUndefined();
  });

  test("a partial pass never fail-closes docs of containers it did not complete", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const tokenB = buildContainerToken({
      connectorId: connector.id,
      containerKey: "repo:o/b",
    });
    // B's doc vanished upstream, but the pass crashes INSIDE container b's
    // enumeration — the diff for b must not run.
    const b = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "b-doc",
      acl: [tokenB],
      containerKey: "repo:o/b",
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "repo:o/a",
            permissions: {},
            documents: [{ sourceId: "a-doc" }],
          },
          {
            containerKey: "repo:o/b",
            permissions: {},
            documents: [{ sourceId: "b-other" }],
          },
        ],
        throwAfterDocs: 1,
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("partial");

    // Neither the incomplete container's set-diff nor the vanished-container /
    // unassigned sweeps ran — the doc keeps its access.
    expect(await docAcl(b.id)).toEqual([tokenB]);
  });

  test("a pass that fails before completing any container finalizes failed, not partial", async ({
    makeOrganization,
  }) => {
    // A deterministic upstream error on the first request (e.g. a malformed-
    // query 400) makes zero progress; a `partial` here would re-enqueue a
    // doomed continuation in a hot loop until the resume-budget breaker
    // trips. With nothing to resume, the run is `failed` and the scheduled
    // cadence is the retry path.
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "repo:o/a",
            permissions: {},
            documents: [{ sourceId: "a" }],
          },
        ],
        throwAfterDocs: 0,
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("failed");

    const [run] = await db
      .select({ status: schema.connectorRunsTable.status })
      .from(schema.connectorRunsTable)
      .where(eq(schema.connectorRunsTable.id, result.runId));
    expect(run.status).toBe("failed");
    const [row] = await db
      .select({
        status: schema.knowledgeBaseConnectorsTable.lastPermissionSyncStatus,
      })
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));
    expect(row.status).toBe("failed");
  });

  test("a re-enqueued run resumes from the checkpoint's completed-container cursor", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    const b = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "b",
      acl: [],
    });
    const containers = (crash: boolean): FakeContainer[] => [
      {
        containerKey: "repo:o/a",
        permissions: { users: ["alice@example.com"] },
        documents: [{ sourceId: "a" }],
      },
      {
        containerKey: "repo:o/b",
        permissions: { users: ["bob@example.com"] },
        documents: crash ? [{ sourceId: "never" }] : [{ sourceId: "b" }],
      },
    ];

    // Run 1: completes container a, crashes inside container b.
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({ containers: containers(true), throwAfterDocs: 1 }),
    );
    const r1 = await permissionSyncService.executePass(connector.id);
    expect(r1.status).toBe("partial");
    expect((await runCheckpoint(r1.runId))?.cursor).toBe("repo:o/a");
    const tokenA = buildContainerToken({
      connectorId: connector.id,
      containerKey: "repo:o/a",
    });
    expect(await docAcl(a.id)).toEqual([tokenA]);

    // Run 2 resumes: container a is skipped/re-done idempotently, b completes.
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({ containers: containers(false) }),
    );
    const r2 = await permissionSyncService.executePass(connector.id);
    expect(r2.status).toBe("success");

    expect(await docAcl(b.id)).toEqual([
      buildContainerToken({
        connectorId: connector.id,
        containerKey: "repo:o/b",
      }),
    ]);
    expect(await docAcl(a.id)).toEqual([tokenA]);
  });

  test("every document ACL write is epoch-fenced: a config change mid-pass no-ops the writes", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    // The pass captures the epoch at start; bump it as enumeration begins so the
    // epoch the writes carry is already stale — every fenced write must no-op.
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "repo:o/r",
            permissions: { users: ["alice@example.com"] },
            documents: [{ sourceId: "a" }],
          },
        ],
        onStart: async () => {
          await db
            .update(schema.knowledgeBaseConnectorsTable)
            .set({ aclConfigEpoch: 5 })
            .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));
        },
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    // The write was computed against the now-stale epoch, so it no-ops: the doc
    // stays fail-closed rather than being tagged under an outdated config.
    expect(await docAcl(a.id)).toEqual([]);
    expect(await chunkAcl(a.id)).toEqual([]);
  });

  test("groups step: completion-gated stale sweep removes revoked memberships", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    // Pre-existing snapshot: g1/alice (still a member) and gone/bob (revoked).
    await db.insert(schema.kbExternalUserGroupsTable).values([
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github",
        groupId: "g1",
        externalAccountId: "alice@example.com",
        memberEmail: "alice@example.com",
        stale: false,
      },
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github",
        groupId: "gone",
        externalAccountId: "bob@example.com",
        memberEmail: "bob@example.com",
        stale: false,
      },
    ]);
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        groups: [{ groupId: "g1", memberEmails: ["alice@example.com"] }],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    const rows = await db
      .select()
      .from(schema.kbExternalUserGroupsTable)
      .where(eq(schema.kbExternalUserGroupsTable.connectorId, connector.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].groupId).toBe("g1");
    expect(rows[0].stale).toBe(false);
    // The revocation is counted — a removal-only refresh must not read as
    // "nothing changed" in the run stats.
    const stats = await runStats(result.runId);
    expect(stats?.membershipsRemoved).toBe(1);
  });

  test("a finished pass invalidates the per-user group-token cache", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "alice@example.com" });
    const connector = await seedConnector(org.id);

    // Warm the cache with the empty pre-pass result.
    const before = await findAccessTokensForUserCached({
      memberEmail: "alice@example.com",
      userId: user.id,
      connectorIds: [connector.id],
    });
    expect(before).toEqual([]);

    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        groups: [{ groupId: "g1", memberEmails: ["alice@example.com"] }],
      }),
    );
    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    // Without invalidation this would still serve the cached [].
    const after = await findAccessTokensForUserCached({
      memberEmail: "alice@example.com",
      userId: user.id,
      connectorIds: [connector.id],
    });
    expect(after).toEqual(["group:github_g1"]);
  });

  test("groups step failure is isolated: the container reconcile still runs and the prior snapshot survives", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    // The prior snapshot that must survive the failed re-enumeration.
    await db.insert(schema.kbExternalUserGroupsTable).values({
      organizationId: org.id,
      connectorId: connector.id,
      connectorType: "github",
      groupId: "g1",
      externalAccountId: "alice@example.com",
      memberEmail: "alice@example.com",
      stale: false,
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "repo:o/r",
            permissions: { users: ["alice@example.com"] },
            documents: [{ sourceId: "a" }],
          },
        ],
        syncGroupsThrows: true,
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    // The pass still succeeds (group step is failure-isolated)...
    expect(result.status).toBe("success");
    // ...documents were still reconciled...
    expect(await docAcl(a.id)).toEqual([
      buildContainerToken({
        connectorId: connector.id,
        containerKey: "repo:o/r",
      }),
    ]);
    // ...and the prior membership snapshot was NOT swept (its rows are stale-
    // flagged but resolution ignores the flag).
    const memberships = await db
      .select()
      .from(schema.kbExternalUserGroupsTable)
      .where(eq(schema.kbExternalUserGroupsTable.connectorId, connector.id));
    expect(memberships).toHaveLength(1);
    const stats = await runStats(result.runId);
    expect(stats?.groupSyncFailed).toBe(true);
  });

  test("a persistence failure in the group step keeps stats honest: only landed batches counted, groupSyncFailed set", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        groups: [
          { groupId: "g1", memberEmails: ["a@example.com"] },
          { groupId: "g2", memberEmails: ["b@example.com"] },
        ],
      }),
    );
    // First batch lands, second throws mid-persist.
    const upsertSpy = vi
      .spyOn(KbExternalUserGroupModel, "upsertMany")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("schema drift"));

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    const stats = await runStats(result.runId);
    expect(stats?.groupSyncFailed).toBe(true);
    // Only the batch that actually persisted is counted (batchSize = 1).
    expect(stats?.membershipsUpserted).toBe(1);
    upsertSpy.mockRestore();
  });

  async function seedSyncState(
    connectorId: string,
    state: Record<string, unknown>,
  ) {
    await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set({ permissionSyncState: state })
      .where(eq(schema.knowledgeBaseConnectorsTable.id, connectorId));
  }

  const connectorState = async (connectorId: string) =>
    (
      await db
        .select({
          state: schema.knowledgeBaseConnectorsTable.permissionSyncState,
        })
        .from(schema.knowledgeBaseConnectorsTable)
        .where(eq(schema.knowledgeBaseConnectorsTable.id, connectorId))
    )[0]?.state;

  test("a clean delta probe skips document enumeration but still VERIFIES groups and audiences", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const a = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: ["user_email:stale@example.com"],
    });
    await seedSyncState(connector.id, {
      lastFullReconcileAt: new Date().toISOString(),
      cursor: "old",
    });
    const fake = makeFakeConnector({
      containers: [{ containerKey: "repo:o/r", documents: [] }],
      groups: [{ groupId: "g1", memberEmails: ["x@example.com"] }],
      probe: { dirtyContainerKeys: [], nextState: { cursor: "advanced" } },
    });
    vi.mocked(getConnector).mockReturnValue(fake);

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    const stats = await runStats(result.runId);
    expect(stats?.mode).toBe("delta");
    expect(stats?.docsScanned).toBe(0);
    // The snapshot never ran and no sweep fired: even a stale-ACL,
    // unassigned doc is untouched by a clean delta (the full backstop owns
    // it)...
    expect(await docAcl(a.id)).toEqual(["user_email:stale@example.com"]);
    // ...but group memberships were still verified by re-enumeration — a
    // clean probe must NOT skip them (upstream membership drift carries no
    // reliable probe signal).
    const memberships = await db
      .select()
      .from(schema.kbExternalUserGroupsTable)
      .where(eq(schema.kbExternalUserGroupsTable.connectorId, connector.id));
    expect(memberships).toHaveLength(1);
    // The probe's cursors advanced; the full-reconcile timestamp survived.
    const state = await connectorState(connector.id);
    expect(state?.cursor).toBe("advanced");
    expect(typeof state?.lastFullReconcileAt).toBe("string");
  });

  test("a dirty delta reconciles ONLY the probed containers — no sweeps", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const tokenB = buildContainerToken({
      connectorId: connector.id,
      containerKey: "repo:o/b",
    });
    const inDirty = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a-doc",
      acl: [],
    });
    // This doc's container is NOT probed dirty and its source vanished — a
    // delta pass must leave it alone (the full backstop handles it).
    const outOfScope = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "b-gone",
      acl: [tokenB],
      containerKey: "repo:o/b",
    });
    await seedSyncState(connector.id, {
      lastFullReconcileAt: new Date().toISOString(),
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "repo:o/a",
            permissions: { users: ["alice@example.com"] },
            documents: [{ sourceId: "a-doc" }],
          },
          {
            containerKey: "repo:o/b",
            permissions: { users: ["bob@example.com"] },
            documents: [{ sourceId: "b-other" }],
          },
        ],
        groups: [{ groupId: "g1", memberEmails: ["x@example.com"] }],
        probe: { dirtyContainerKeys: ["repo:o/a"] },
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    const stats = await runStats(result.runId);
    expect(stats?.mode).toBe("delta");
    // The dirty container reconciled...
    expect(await docAcl(inDirty.id)).toEqual([
      buildContainerToken({
        connectorId: connector.id,
        containerKey: "repo:o/a",
      }),
    ]);
    // ...the unprobed container was neither enumerated nor swept...
    expect(await docAcl(outOfScope.id)).toEqual([tokenB]);
    expect(stats?.containersSynced).toBe(1);
    // ...and groups were verified anyway — every pass re-enumerates them.
    const memberships = await db
      .select()
      .from(schema.kbExternalUserGroupsTable)
      .where(eq(schema.kbExternalUserGroupsTable.connectorId, connector.id));
    expect(memberships).toHaveLength(1);
  });

  test("a delta pass adopts locally-unassigned documents: their containers join the scope even on a clean probe", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    // Locally new, upstream old: ingested after the last pass (container_key
    // NULL, fail-closed), no upstream drift for the probe to see.
    const backfilled = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a-doc",
      acl: [],
      metadata: { repo: "o/a" },
    });
    // Already assigned: its container must NOT be pulled into scope.
    const tokenB = buildContainerToken({
      connectorId: connector.id,
      containerKey: "repo:o/b",
    });
    const assigned = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "b-doc",
      acl: [tokenB],
      containerKey: "repo:o/b",
      metadata: { repo: "o/b" },
    });
    await seedSyncState(connector.id, {
      lastFullReconcileAt: new Date().toISOString(),
    });
    const fake = makeFakeConnector({
      containers: [
        {
          containerKey: "repo:o/a",
          permissions: { users: ["alice@example.com"] },
          documents: [{ sourceId: "a-doc" }],
        },
        {
          containerKey: "repo:o/b",
          permissions: { users: ["bob@example.com"] },
          documents: [{ sourceId: "b-doc" }],
        },
      ],
      probe: { dirtyContainerKeys: [] },
      scopeKeyForDocument: (metadata) =>
        typeof metadata.repo === "string" ? `repo:${metadata.repo}` : null,
    });
    vi.mocked(getConnector).mockReturnValue(fake);

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    const stats = await runStats(result.runId);
    expect(stats?.mode).toBe("delta");
    expect(stats?.docsAdopted).toBe(1);
    expect(await docAcl(backfilled.id)).toEqual([
      buildContainerToken({
        connectorId: connector.id,
        containerKey: "repo:o/a",
      }),
    ]);
    expect((await docRow(backfilled.id))?.containerKey).toBe("repo:o/a");
    // The assigned doc's container stayed out of scope — zero writes there.
    expect(stats?.containersSynced).toBe(1);
    expect(await docAcl(assigned.id)).toEqual([tokenB]);
  });

  test("an unassigned doc whose metadata cannot be scoped stays fail-closed for the full backstop; a scopable one still adopts", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const unscopable = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "no-meta",
      acl: [],
      metadata: {},
    });
    const scopable = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a-doc",
      acl: [],
      metadata: { repo: "o/a" },
    });
    await seedSyncState(connector.id, {
      lastFullReconcileAt: new Date().toISOString(),
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "repo:o/a",
            permissions: { users: ["alice@example.com"] },
            documents: [{ sourceId: "a-doc" }],
          },
        ],
        probe: { dirtyContainerKeys: [] },
        scopeKeyForDocument: (metadata) =>
          typeof metadata.repo === "string" ? `repo:${metadata.repo}` : null,
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    const stats = await runStats(result.runId);
    expect(stats?.mode).toBe("delta");
    expect(stats?.docsAdopted).toBe(1);
    expect((await docRow(scopable.id))?.containerKey).toBe("repo:o/a");
    // Unscopable: untouched (still fail-closed, still unassigned) — the
    // periodic full reconcile owns it.
    expect(await docAcl(unscopable.id)).toEqual([]);
    expect((await docRow(unscopable.id))?.containerKey).toBeNull();
  });

  test("a clean delta with nothing awaiting adoption stays a no-op even when the connector can scope adoption", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const tokenA = buildContainerToken({
      connectorId: connector.id,
      containerKey: "repo:o/a",
    });
    await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a-doc",
      acl: [tokenA],
      containerKey: "repo:o/a",
      metadata: { repo: "o/a" },
    });
    await seedSyncState(connector.id, {
      lastFullReconcileAt: new Date().toISOString(),
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [{ containerKey: "repo:o/a", documents: [] }],
        probe: { dirtyContainerKeys: [] },
        scopeKeyForDocument: (metadata) =>
          typeof metadata.repo === "string" ? `repo:${metadata.repo}` : null,
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    const stats = await runStats(result.runId);
    expect(stats?.mode).toBe("delta");
    expect(stats?.docsScanned).toBe(0);
    expect(stats?.containersSynced).toBe(0);
  });

  test("every delta pass re-verifies stored container audiences without scanning a single document", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const tokenA = buildContainerToken({
      connectorId: connector.id,
      containerKey: "repo:o/a",
    });
    const doc = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a-doc",
      acl: [tokenA],
      containerKey: "repo:o/a",
    });
    await db.insert(schema.kbContainerAclsTable).values({
      organizationId: org.id,
      connectorId: connector.id,
      containerKey: "repo:o/a",
      acl: ["user_email:old@example.com"],
    });
    await seedSyncState(connector.id, {
      lastFullReconcileAt: new Date().toISOString(),
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [{ containerKey: "repo:o/a", documents: [] }],
        // The probe is completely clean — verification must not depend on it.
        probe: { dirtyContainerKeys: [] },
        refreshAudiences: {
          "repo:o/a": { users: ["new@example.com"] },
        },
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    const stats = await runStats(result.runId);
    expect(stats?.mode).toBe("delta");
    // The audience row IS the entire write cost of the upstream change.
    expect(stats?.containersChanged).toBe(1);
    expect(stats?.docsScanned).toBe(0);
    expect(stats?.aclsChanged).toBe(0);
    expect((await containerRow(connector.id, "repo:o/a"))?.acl).toEqual([
      "user_email:new@example.com",
    ]);
    // The document still references the container by token — untouched.
    expect(await docAcl(doc.id)).toEqual([tokenA]);
  });

  test("a delta pass persists every re-resolved audience when they all fit in one batch", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    // The real batch size, which exceeds the container count here — so every
    // audience rides out on the trailing flush. The rest of this suite runs
    // with batchSize = 1, where that flush is always empty and a missing one
    // would go unnoticed.
    permissionSyncService.batchSize = 200;

    const audiences = {
      "repo:o/a": "alice@example.com",
      "repo:o/b": "bob@example.com",
      "repo:o/c": "carol@example.com",
    };
    for (const containerKey of Object.keys(audiences)) {
      await db.insert(schema.kbContainerAclsTable).values({
        organizationId: org.id,
        connectorId: connector.id,
        containerKey,
        acl: ["user_email:old@example.com"],
      });
      // A pass over a connector with no documents fast-exits before it ever
      // reaches the audiences.
      await seedDoc({
        organizationId: org.id,
        connectorId: connector.id,
        sourceId: `${containerKey}-doc`,
        acl: [buildContainerToken({ connectorId: connector.id, containerKey })],
        containerKey,
      });
    }
    await seedSyncState(connector.id, {
      lastFullReconcileAt: new Date().toISOString(),
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: Object.keys(audiences).map((containerKey) => ({
          containerKey,
          documents: [],
        })),
        probe: { dirtyContainerKeys: [] },
        refreshAudiences: Object.fromEntries(
          Object.entries(audiences).map(([containerKey, email]) => [
            containerKey,
            { users: [email] },
          ]),
        ),
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");
    expect((await runStats(result.runId))?.containersChanged).toBe(3);
    for (const [containerKey, email] of Object.entries(audiences)) {
      expect((await containerRow(connector.id, containerKey))?.acl).toEqual([
        `user_email:${email}`,
      ]);
    }
  });

  test("a container whose permissions could not be read is counted on the run, not silently fail-closed", async ({
    makeOrganization,
  }) => {
    // The end state of an unreadable container and of a container upstream
    // grants nobody is identical — an empty audience, every document in it
    // hidden. Only one of them is a problem, and without this counter the run
    // reported both as a clean success.
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const doc = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "project:ENG",
            permissions: { isPublic: false, users: [], groups: [] },
            audienceResolutionFailed: true,
            documents: [{ sourceId: "a" }],
          },
        ],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);

    expect(result.status).toBe("success");
    expect((await runStats(result.runId))?.containerAudienceFailures).toBe(1);
    // Still fail-closed, which is the right answer — it is just no longer a
    // silent one. The document holds the container token; the container grants
    // nobody, so it resolves to nobody.
    expect(await docAcl(doc.id)).toEqual([
      buildContainerToken({
        connectorId: connector.id,
        containerKey: "project:ENG",
      }),
    ]);
    expect((await containerRow(connector.id, "project:ENG"))?.acl).toEqual([]);
  });

  test("a delta pass does not rewrite container rows whose audience is unchanged", async ({
    makeOrganization,
  }) => {
    // A delta pass re-resolves EVERY stored container to verify it, and the
    // steady-state answer is "still the same". Rewriting them all anyway meant a
    // connector with thousands of spaces rewrote its whole container table every
    // half hour to store what was already there.
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    permissionSyncService.batchSize = 200;

    const containerKey = "repo:o/a";
    await db.insert(schema.kbContainerAclsTable).values({
      organizationId: org.id,
      connectorId: connector.id,
      containerKey,
      acl: ["user_email:alice@example.com"],
    });
    await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "doc-1",
      acl: [buildContainerToken({ connectorId: connector.id, containerKey })],
      containerKey,
    });
    await seedSyncState(connector.id, {
      lastFullReconcileAt: new Date().toISOString(),
    });
    const before = await containerRow(connector.id, containerKey);

    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [{ containerKey, documents: [] }],
        probe: { dirtyContainerKeys: [] },
        // Upstream still says exactly what the stored row already says.
        refreshAudiences: { [containerKey]: { users: ["alice@example.com"] } },
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);

    expect(result.status).toBe("success");
    expect((await runStats(result.runId))?.containersChanged).toBe(0);
    // `updated_at` is the tell: an upsert bumps it even when the row's contents
    // land identical, so an unchanged timestamp is proof no write happened.
    const after = await containerRow(connector.id, containerKey);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  test("a full pass rewrites an unchanged container so its stale mark is cleared", async ({
    makeOrganization,
  }) => {
    // The other side of the same coin, and the reason the skip has to be
    // conditional: a full pass marks every row stale up front and deletes
    // whatever is still marked when it finishes. Skipping the write of an
    // unchanged container there would sweep it away and fail-close every
    // document in it.
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    permissionSyncService.batchSize = 200;

    const containerKey = "repo:o/a";
    await db.insert(schema.kbContainerAclsTable).values({
      organizationId: org.id,
      connectorId: connector.id,
      containerKey,
      acl: ["user_email:alice@example.com"],
    });
    const doc = await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "doc-1",
      acl: [buildContainerToken({ connectorId: connector.id, containerKey })],
      containerKey,
    });

    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey,
            permissions: { users: ["alice@example.com"] },
            documents: [{ sourceId: "doc-1" }],
          },
        ],
      }),
    );

    const result = await permissionSyncService.executePass(connector.id, {
      mode: "full",
    });

    expect(result.status).toBe("success");
    // Survived the sweep, and the document still resolves through it.
    const row = await containerRow(connector.id, containerKey);
    expect(row?.stale).toBe(false);
    expect(row?.acl).toEqual(["user_email:alice@example.com"]);
    expect(await docAcl(doc.id)).toEqual([
      buildContainerToken({ connectorId: connector.id, containerKey }),
    ]);
  });

  test("the pass injects a working mapping resolver: a seeded member override materializes in the audience", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    // Mixed case pins normalization: the audience must hold the normalized
    // email so query-time base tokens match.
    const user = await makeUser({ email: "Mapped+User@Example.com" });
    const connector = await seedConnector(org.id);
    await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a-doc",
      acl: [],
    });
    await db.insert(schema.kbMemberOverridesTable).values({
      organizationId: org.id,
      connectorId: connector.id,
      externalAccountId: "acc-hidden",
      userId: user.id,
    });
    const fake = makeFakeConnector({ containers: [] });
    // A connector that (like Jira/Confluence) resolves a directly-granted
    // account through the injected mapping.
    fake.syncPermissionSnapshot = async function* (params: {
      resolveMappedEmail?: (id: string) => string | null;
    }) {
      const email = params.resolveMappedEmail?.("acc-hidden");
      yield {
        kind: "container" as const,
        containerKey: "repo:o/r",
        permissions: { users: email ? [email] : [] },
        cursor: "repo:o/r",
      };
    };
    vi.mocked(getConnector).mockReturnValue(fake);

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    expect((await containerRow(connector.id, "repo:o/r"))?.acl).toEqual([
      "user_email:mapped+user@example.com",
    ]);
  });

  test("an upstream REVOCATION lands on the very next delta pass — no probe signal required", async ({
    makeOrganization,
  }) => {
    // The production incident this pins: a user removed from a Jira project
    // upstream; the audit record ingested minutes late and worded unlike the
    // grant, so probe-based inference missed it and the stale audience stayed
    // fail-OPEN. Verification must not depend on any probe signal.
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    const tokenA = buildContainerToken({
      connectorId: connector.id,
      containerKey: "repo:o/a",
    });
    await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a-doc",
      acl: [tokenA],
      containerKey: "repo:o/a",
    });
    await db.insert(schema.kbContainerAclsTable).values({
      organizationId: org.id,
      connectorId: connector.id,
      containerKey: "repo:o/a",
      acl: ["user_email:keep@example.com", "user_email:revoked@example.com"],
    });
    await seedSyncState(connector.id, {
      lastFullReconcileAt: new Date().toISOString(),
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [{ containerKey: "repo:o/a", documents: [] }],
        probe: { dirtyContainerKeys: [] },
        // Upstream truth: only `keep` still has access.
        refreshAudiences: {
          "repo:o/a": { users: ["keep@example.com"] },
        },
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    const stats = await runStats(result.runId);
    expect(stats?.mode).toBe("delta");
    expect(stats?.containersChanged).toBe(1);
    expect(stats?.docsScanned).toBe(0);
    expect((await containerRow(connector.id, "repo:o/a"))?.acl).toEqual([
      "user_email:keep@example.com",
    ]);
  });

  test("a probe-capable connector without the refresh hook always promotes to a FULL pass", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a-doc",
      acl: [],
    });
    await seedSyncState(connector.id, {
      lastFullReconcileAt: new Date().toISOString(),
    });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [
          {
            containerKey: "repo:o/a",
            permissions: { users: ["alice@example.com"] },
            documents: [{ sourceId: "a-doc" }],
          },
        ],
        probe: { dirtyContainerKeys: [] },
        withoutRefreshHook: true,
      }),
    );

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");

    const stats = await runStats(result.runId);
    expect(stats?.mode).toBe("full");
    expect(stats?.docsScanned).toBe(1);
  });

  test("fullRequired, a stale full-reconcile timestamp, or a manual sync all promote to a FULL pass", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    await seedDoc({
      organizationId: org.id,
      connectorId: connector.id,
      sourceId: "a",
      acl: [],
    });
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    // fullRequired probe → full.
    await seedSyncState(connector.id, { lastFullReconcileAt: fresh });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [{ containerKey: "repo:o/r", documents: [] }],
        probe: { dirtyContainerKeys: [], fullRequired: true },
      }),
    );
    const r1 = await permissionSyncService.executePass(connector.id);
    expect((await runStats(r1.runId))?.mode).toBe("full");

    // Aged-out timestamp → full even with a clean probe.
    await seedSyncState(connector.id, { lastFullReconcileAt: stale });
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [{ containerKey: "repo:o/r", documents: [] }],
        probe: { dirtyContainerKeys: [] },
      }),
    );
    const r2 = await permissionSyncService.executePass(connector.id);
    expect((await runStats(r2.runId))?.mode).toBe("full");
    // A successful full pass refreshes the timestamp.
    const state = await connectorState(connector.id);
    expect(Date.parse(String(state?.lastFullReconcileAt))).toBeGreaterThan(
      Date.parse(stale),
    );

    // Manual sync → full despite a fresh timestamp and clean probe.
    vi.mocked(getConnector).mockReturnValue(
      makeFakeConnector({
        containers: [{ containerKey: "repo:o/r", documents: [] }],
        probe: { dirtyContainerKeys: [] },
      }),
    );
    const r3 = await permissionSyncService.executePass(connector.id, {
      mode: "full",
    });
    expect((await runStats(r3.runId))?.mode).toBe("full");
  });

  test("fast-exits and records a permission run for a connector with no documents", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await seedConnector(org.id);
    vi.mocked(getConnector).mockReturnValue(makeFakeConnector({}));

    const result = await permissionSyncService.executePass(connector.id);
    expect(result.status).toBe("success");
    expect(result.runId).not.toBe("");

    const [run] = await db
      .select()
      .from(schema.connectorRunsTable)
      .where(eq(schema.connectorRunsTable.id, result.runId));
    expect(run?.status).toBe("success");
    expect(run?.runType).toBe("permission");
  });
});
