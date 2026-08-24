import { describe, expect, it, vi } from "vitest";
import type {
  ConnectorSyncBatch,
  GroupMembershipYield,
  PermissionSnapshotYield,
  PermissionSyncParams,
} from "@/types";
import { OutlineConnector } from "./outline-connector";

const OUTLINE_URL = "https://app.getoutline.com";
const credentials = { apiToken: "ol_api_test_token" };
const baseConfig = { outlineUrl: OUTLINE_URL };

type SpyTarget = {
  fetchWithRetry: (...args: unknown[]) => unknown;
  rateLimit: () => unknown;
};

function makeDocument(
  id: string,
  title: string,
  opts?: {
    updatedAt?: string;
    collectionId?: string;
    text?: string;
    urlId?: string;
    url?: string;
  },
) {
  return {
    id,
    title,
    text: opts?.text ?? `Content of ${title}`,
    urlId: opts?.urlId ?? id.slice(0, 8),
    collectionId: opts?.collectionId ?? "col-1",
    parentDocumentId: null,
    url: opts?.url ?? `${OUTLINE_URL}/doc/${opts?.urlId ?? id.slice(0, 8)}`,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: opts?.updatedAt ?? "2024-01-15T10:00:00.000Z",
    publishedAt: "2024-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
  };
}

function makeListResponse(
  docs: ReturnType<typeof makeDocument>[],
  opts?: { hasNextPath?: boolean; offset?: number; limit?: number },
) {
  const limit = opts?.limit ?? 25;
  const offset = opts?.offset ?? 0;
  return {
    ok: true,
    json: async () => ({
      ok: true,
      data: docs,
      pagination: {
        limit,
        offset,
        nextPath: opts?.hasNextPath
          ? `/api/documents.list?limit=${limit}&offset=${offset + limit}`
          : undefined,
      },
    }),
  } as unknown as Response;
}

function makeAuthResponse(ok = true) {
  return {
    ok,
    json: async () => ({
      ok,
      data: ok
        ? {
            user: { id: "user-1", name: "Test User" },
            team: { id: "team-1", name: "Test Team" },
          }
        : { ok: false, error: "Unauthenticated" },
    }),
    text: async () => (ok ? "" : "Unauthenticated"),
  } as unknown as Response;
}

describe("OutlineConnector", () => {
  describe("validateConfig", () => {
    it("returns valid for a correct config", async () => {
      const connector = new OutlineConnector();
      const result = await connector.validateConfig(baseConfig);
      expect(result).toEqual({ valid: true });
    });

    it("prepends https:// when protocol is missing", async () => {
      const connector = new OutlineConnector();
      const result = await connector.validateConfig({
        outlineUrl: "app.getoutline.com",
      });
      expect(result).toEqual({ valid: true });
    });

    it("returns invalid for missing outlineUrl", async () => {
      const connector = new OutlineConnector();
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns valid with optional collectionIds", async () => {
      const connector = new OutlineConnector();
      const result = await connector.validateConfig({
        ...baseConfig,
        collectionIds: ["col-1", "col-2"],
      });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("testConnection", () => {
    it("returns success when auth.info succeeds", async () => {
      const connector = new OutlineConnector();
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValue(makeAuthResponse(true));

      const result = await connector.testConnection({
        config: baseConfig,
        credentials,
      });
      expect(result).toEqual({ success: true });
    });

    it("returns failure when auth.info returns 401", async () => {
      const connector = new OutlineConnector();
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, error: "Unauthenticated" }),
        text: async () => "Unauthenticated",
      } as unknown as Response);

      const result = await connector.testConnection({
        config: baseConfig,
        credentials,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/401/);
    });

    it("returns failure on network error", async () => {
      const connector = new OutlineConnector();
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockRejectedValue(new Error("Network error"));

      const result = await connector.testConnection({
        config: baseConfig,
        credentials,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Connection failed/);
    });

    it("returns failure for invalid config", async () => {
      const connector = new OutlineConnector();
      const result = await connector.testConnection({
        config: {},
        credentials,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("sync", () => {
    it("syncs a single page of documents", async () => {
      const connector = new OutlineConnector();
      const docs = [
        makeDocument("doc-1", "Doc One"),
        makeDocument("doc-2", "Doc Two"),
      ];
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValue(makeListResponse(docs));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents[0].id).toBe("doc-1");
      expect(batches[0].documents[0].title).toBe("Doc One");
      expect(batches[0].documents[0].content).toContain("# Doc One");
      expect(batches[0].hasMore).toBe(false);
    });

    it("maps document fields to ConnectorDocument correctly", async () => {
      const connector = new OutlineConnector();
      const doc = makeDocument("doc-1", "My Doc", {
        text: "Hello world",
        urlId: "abc123",
        url: `${OUTLINE_URL}/doc/abc123`,
        updatedAt: "2024-06-01T12:00:00.000Z",
        collectionId: "col-xyz",
      });
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValue(makeListResponse([doc]));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const connDoc = batches[0].documents[0];
      expect(connDoc.id).toBe("doc-1");
      expect(connDoc.title).toBe("My Doc");
      expect(connDoc.content).toBe("# My Doc\n\nHello world");
      expect(connDoc.sourceUrl).toBe(`${OUTLINE_URL}/doc/abc123`);
      expect(connDoc.metadata.collectionId).toBe("col-xyz");
      expect(connDoc.updatedAt).toEqual(new Date("2024-06-01T12:00:00.000Z"));
    });

    it("paginates across multiple pages", async () => {
      const connector = new OutlineConnector();
      const page1 = Array.from({ length: 25 }, (_, i) =>
        makeDocument(`doc-${i}`, `Doc ${i}`, {
          updatedAt: new Date(Date.now() - i * 1000).toISOString(),
        }),
      );
      const page2 = [makeDocument("doc-25", "Doc 25")];

      const mockFetch = vi
        .spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeListResponse(page1, { hasNextPath: true, limit: 25 }),
        )
        .mockResolvedValueOnce(
          makeListResponse(page2, { hasNextPath: false, limit: 25 }),
        );
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].hasMore).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("filters out documents older than or equal to the checkpoint", async () => {
      const connector = new OutlineConnector();
      const checkpoint = {
        type: "outline" as const,
        lastSyncedAt: "2024-06-01T00:00:00.000Z",
      };

      const docs = [
        makeDocument("doc-new", "New Doc", {
          updatedAt: "2024-06-15T00:00:00.000Z",
        }),
        makeDocument("doc-old", "Old Doc", {
          updatedAt: "2024-05-01T00:00:00.000Z",
        }),
      ];
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValue(makeListResponse(docs));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("doc-new");
      expect(batches[0].hasMore).toBe(false);
    });

    it("syncs per-collection when collectionIds are provided", async () => {
      const connector = new OutlineConnector();
      const col1Docs = [
        makeDocument("doc-1", "Col1 Doc", { collectionId: "col-1" }),
      ];
      const col2Docs = [
        makeDocument("doc-2", "Col2 Doc", { collectionId: "col-2" }),
      ];

      const mockFetch = vi
        .spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(makeListResponse(col1Docs))
        .mockResolvedValueOnce(makeListResponse(col2Docs));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...baseConfig, collectionIds: ["col-1", "col-2"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Verify each call used the correct collectionId
      const call1Body = JSON.parse(
        (mockFetch.mock.calls[0][1] as RequestInit).body as string,
      );
      const call2Body = JSON.parse(
        (mockFetch.mock.calls[1][1] as RequestInit).body as string,
      );
      expect(call1Body.collectionId).toBe("col-1");
      expect(call2Body.collectionId).toBe("col-2");
    });

    it("advances lastSyncedAt only after all collections are swept, and to the run's syncStart (not max updatedAt)", async () => {
      // syncStart anchoring is what closes the race where a doc in an
      // already-swept collection is edited mid-run: the previous impl set
      // lastSyncedAt = max(updatedAt) and could silently move past the edit.
      // We anchor the checkpoint to the run's start instead — next run's
      // cutoff is guaranteed to include anything edited during this run.
      const runStart = new Date("2024-07-15T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(runStart);
      try {
        const connector = new OutlineConnector();
        const oldCheckpoint = "2024-06-01T00:00:00.000Z";
        const col1Docs = [
          makeDocument("doc-1", "Recent Col1 Doc", {
            collectionId: "col-1",
            updatedAt: "2024-07-01T00:00:00.000Z",
          }),
        ];

        vi.spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
          .mockResolvedValueOnce(makeListResponse(col1Docs))
          .mockResolvedValueOnce(makeListResponse([]));
        vi.spyOn(
          connector as unknown as SpyTarget,
          "rateLimit",
        ).mockResolvedValue(undefined);

        const batches: ConnectorSyncBatch[] = [];
        for await (const batch of connector.sync({
          config: { ...baseConfig, collectionIds: ["col-1", "col-2"] },
          credentials,
          checkpoint: { type: "outline" as const, lastSyncedAt: oldCheckpoint },
        })) {
          batches.push(batch);
        }

        // Intermediate batch must preserve the previous value — the runner
        // persists every yielded checkpoint and may stop before later
        // collections are visited.
        expect(batches[0].checkpoint.lastSyncedAt).toBe(oldCheckpoint);
        // Terminal batch promotes syncStart to lastSyncedAt.
        expect(batches.at(-1)?.checkpoint.lastSyncedAt).toBe(
          runStart.toISOString(),
        );
        // No batch regresses below the input checkpoint.
        for (const batch of batches) {
          const lastSyncedAt = (batch.checkpoint as { lastSyncedAt?: string })
            .lastSyncedAt;
          expect(lastSyncedAt).toBeDefined();
          expect((lastSyncedAt ?? "") >= oldCheckpoint).toBe(true);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not skip a later collection when stopped after the first batch", async () => {
      // Regression: col-1 yields a newer doc with hasMore=true; if the sync
      // runner persists the first batch's checkpoint and then stops (time
      // budget), col-2's doc — older than col-1's max but newer than the old
      // checkpoint — must not be filtered out on resume.
      const connector = new OutlineConnector();
      const oldCheckpoint = "2024-06-01T00:00:00.000Z";
      const col1Page1 = [
        makeDocument("col1-newer", "Col1 Newer", {
          collectionId: "col-1",
          updatedAt: "2024-07-01T00:00:00.000Z",
        }),
      ];

      const fetchSpy = vi
        .spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeListResponse(col1Page1, { hasNextPath: true }),
        );
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const generator = connector.sync({
        config: { ...baseConfig, collectionIds: ["col-1", "col-2"] },
        credentials,
        checkpoint: { type: "outline" as const, lastSyncedAt: oldCheckpoint },
      });

      const first = await generator.next();
      expect(first.done).toBe(false);
      const firstBatch = first.value as ConnectorSyncBatch;

      // The runner would persist this checkpoint and then stop. It MUST still
      // be the old value — advancing to 2024-07-01 would cause col-2's
      // 2024-06-15 doc to be filtered out on the follow-up run's syncFrom.
      expect(firstBatch.checkpoint.lastSyncedAt).toBe(oldCheckpoint);
      // hasMore must reflect the full sweep, not just this collection.
      expect(firstBatch.hasMore).toBe(true);
      // Only col-1 was fetched before we stopped.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("promotes syncStart to lastSyncedAt on successful completion", async () => {
      const runStart = new Date("2024-07-15T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(runStart);
      try {
        const connector = new OutlineConnector();
        const checkpoint = {
          type: "outline" as const,
          lastSyncedAt: "2024-06-01T00:00:00.000Z",
        };
        const docs = [
          makeDocument("doc-1", "Recent Doc", {
            updatedAt: "2024-06-15T00:00:00.000Z",
          }),
        ];
        vi.spyOn(
          connector as unknown as SpyTarget,
          "fetchWithRetry",
        ).mockResolvedValue(makeListResponse(docs));
        vi.spyOn(
          connector as unknown as SpyTarget,
          "rateLimit",
        ).mockResolvedValue(undefined);

        const batches: ConnectorSyncBatch[] = [];
        for await (const batch of connector.sync({
          config: baseConfig,
          credentials,
          checkpoint,
        })) {
          batches.push(batch);
        }

        expect(batches.at(-1)?.checkpoint.lastSyncedAt).toBe(
          runStart.toISOString(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("advances lastSyncedAt to syncStart even when no documents are returned", async () => {
      // A completed sweep that observed no updates is still a completed sweep:
      // the next run's cutoff should move forward so it does not re-scan a
      // window we already confirmed clean.
      const runStart = new Date("2024-07-15T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(runStart);
      try {
        const connector = new OutlineConnector();
        const checkpoint = {
          type: "outline" as const,
          lastSyncedAt: "2024-06-01T00:00:00.000Z",
        };
        vi.spyOn(
          connector as unknown as SpyTarget,
          "fetchWithRetry",
        ).mockResolvedValue(makeListResponse([]));
        vi.spyOn(
          connector as unknown as SpyTarget,
          "rateLimit",
        ).mockResolvedValue(undefined);

        const batches: ConnectorSyncBatch[] = [];
        for await (const batch of connector.sync({
          config: baseConfig,
          credentials,
          checkpoint,
        })) {
          batches.push(batch);
        }

        expect(batches.at(-1)?.checkpoint.lastSyncedAt).toBe(
          runStart.toISOString(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("queries documents.list with sort: createdAt, direction: ASC for stable iteration", async () => {
      const connector = new OutlineConnector();
      const fetchSpy = vi
        .spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValue(makeListResponse([]));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      for await (const _ of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: null,
      })) {
        // drain
      }

      const body = JSON.parse(
        (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
      );
      expect(body.sort).toBe("createdAt");
      expect(body.direction).toBe("ASC");
    });

    it("re-ingests a mid-run edit in an earlier collection on the following run (race regression)", async () => {
      // The race that max(updatedAt) checkpointing permitted:
      //   Run 1 starts at 12:00. It sweeps col-1 first — doc-a is ingested
      //   with its pre-run updatedAt (2024-07-01).
      //   While col-2 is being swept, doc-a is edited externally at 12:03.
      //   doc-b in col-2 is edited at 12:09 and ingested by the col-2 sweep.
      //   Run 1 completes.
      //     Old impl: lastSyncedAt = max(updatedAt) = 12:09. Next run's
      //     syncFrom = 12:09. doc-a's 12:03 edit < 12:09 so it is silently
      //     skipped on every subsequent run until someone re-edits it.
      //     New impl: lastSyncedAt = run1's syncStart = 12:00. Next run's
      //     syncFrom = 12:00. doc-a's 12:03 edit > 12:00 and is re-ingested.
      const run1Start = new Date("2024-07-15T12:00:00.000Z");
      const run2Start = new Date("2024-07-15T12:15:00.000Z");

      vi.useFakeTimers();
      vi.setSystemTime(run1Start);
      const connector1 = new OutlineConnector();
      const col1Run1 = [
        makeDocument("doc-a", "Doc A", {
          collectionId: "col-1",
          updatedAt: "2024-07-01T00:00:00.000Z",
        }),
      ];
      const col2Run1 = [
        makeDocument("doc-b", "Doc B", {
          collectionId: "col-2",
          // Edited mid-run-1, after col-1's sweep finished.
          updatedAt: "2024-07-15T12:09:00.000Z",
        }),
      ];
      vi.spyOn(connector1 as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(makeListResponse(col1Run1))
        .mockResolvedValueOnce(makeListResponse(col2Run1));
      vi.spyOn(
        connector1 as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const run1Batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector1.sync({
        config: { ...baseConfig, collectionIds: ["col-1", "col-2"] },
        credentials,
        checkpoint: null,
      })) {
        run1Batches.push(batch);
      }

      const run1Checkpoint = run1Batches.at(-1)?.checkpoint;
      // syncStart anchoring: lastSyncedAt = run1Start, NOT max(updatedAt).
      expect(run1Checkpoint?.lastSyncedAt).toBe(run1Start.toISOString());

      // Run 2: doc-a's mid-run-1 edit now surfaces in col-1 with an
      // updatedAt that sits BELOW doc-b's 12:09 (the old max). This is the
      // exact "sub-max edit" the previous impl silently dropped.
      vi.setSystemTime(run2Start);
      const connector2 = new OutlineConnector();
      const col1Run2 = [
        makeDocument("doc-a", "Doc A (edited mid-run-1)", {
          collectionId: "col-1",
          updatedAt: "2024-07-15T12:03:00.000Z",
        }),
      ];
      const col2Run2: ReturnType<typeof makeDocument>[] = [];
      vi.spyOn(connector2 as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(makeListResponse(col1Run2))
        .mockResolvedValueOnce(makeListResponse(col2Run2));
      vi.spyOn(
        connector2 as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const run2Batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector2.sync({
        config: { ...baseConfig, collectionIds: ["col-1", "col-2"] },
        credentials,
        checkpoint: run1Checkpoint as Record<string, unknown>,
      })) {
        run2Batches.push(batch);
      }
      vi.useRealTimers();

      const run2Docs = run2Batches.flatMap((b) => b.documents);
      expect(run2Docs.map((d) => d.id)).toContain("doc-a");
      expect(run2Batches.at(-1)?.checkpoint.lastSyncedAt).toBe(
        run2Start.toISOString(),
      );
    });

    it("records lastCollectionId + lastDocumentId in intermediate checkpoints for resume", async () => {
      const runStart = new Date("2024-07-15T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(runStart);
      try {
        const connector = new OutlineConnector();
        const col1Docs = [
          makeDocument("doc-1", "Col1 Doc", {
            collectionId: "col-1",
            updatedAt: "2024-07-10T00:00:00.000Z",
          }),
        ];
        vi.spyOn(
          connector as unknown as SpyTarget,
          "fetchWithRetry",
        ).mockResolvedValueOnce(
          makeListResponse(col1Docs, { hasNextPath: true }),
        );
        vi.spyOn(
          connector as unknown as SpyTarget,
          "rateLimit",
        ).mockResolvedValue(undefined);

        const generator = connector.sync({
          config: { ...baseConfig, collectionIds: ["col-1", "col-2"] },
          credentials,
          checkpoint: null,
        });
        const { value } = await generator.next();
        const first = value as ConnectorSyncBatch;
        const checkpoint = first.checkpoint as {
          syncStart?: string;
          lastCollectionId?: string;
          lastDocumentId?: string;
          lastSyncedAt?: string;
        };
        expect(checkpoint.syncStart).toBe(runStart.toISOString());
        expect(checkpoint.lastCollectionId).toBe("col-1");
        expect(checkpoint.lastDocumentId).toBe("doc-1");
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumes from lastCollectionId and skips already-processed collections", async () => {
      const persistedSyncStart = "2024-07-15T12:00:00.000Z";
      const resumeAt = new Date("2024-07-15T12:05:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(resumeAt);
      try {
        const connector = new OutlineConnector();
        const fetchSpy = vi
          .spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
          .mockResolvedValueOnce(makeListResponse([]));
        vi.spyOn(
          connector as unknown as SpyTarget,
          "rateLimit",
        ).mockResolvedValue(undefined);

        const batches: ConnectorSyncBatch[] = [];
        for await (const batch of connector.sync({
          config: {
            ...baseConfig,
            collectionIds: ["col-1", "col-2", "col-3"],
          },
          credentials,
          checkpoint: {
            type: "outline" as const,
            syncStart: persistedSyncStart,
            lastCollectionId: "col-3",
          },
        })) {
          batches.push(batch);
        }

        // Only col-3 should have been fetched — col-1 and col-2 were already
        // processed before the interruption.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const body = JSON.parse(
          (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
        );
        expect(body.collectionId).toBe("col-3");

        // Completing the resumed sweep promotes the PERSISTED syncStart —
        // not "now" — so the cutoff still covers edits made during the
        // original interrupted run.
        expect(batches.at(-1)?.checkpoint.lastSyncedAt).toBe(
          persistedSyncStart,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumes from lastDocumentId by skipping past it within the bookmarked collection", async () => {
      const connector = new OutlineConnector();
      const col1Page = [
        makeDocument("doc-a", "A", { collectionId: "col-1" }),
        makeDocument("doc-b", "B", { collectionId: "col-1" }),
        makeDocument("doc-c", "C", { collectionId: "col-1" }),
      ];
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValue(makeListResponse(col1Page));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...baseConfig, collectionIds: ["col-1"] },
        credentials,
        checkpoint: {
          type: "outline" as const,
          syncStart: "2024-07-15T12:00:00.000Z",
          lastCollectionId: "col-1",
          lastDocumentId: "doc-b",
        },
      })) {
        batches.push(batch);
      }

      const ingested = batches.flatMap((b) => b.documents).map((d) => d.id);
      // doc-a and doc-b already processed pre-interruption; only doc-c is
      // ingested on resume.
      expect(ingested).toEqual(["doc-c"]);
    });

    it("excludes documents whose updatedAt is at or before syncFrom", async () => {
      const connector = new OutlineConnector();
      const docs = [
        makeDocument("equal", "Equal", {
          updatedAt: "2024-06-01T00:00:00.000Z",
        }),
        makeDocument("older", "Older", {
          updatedAt: "2024-05-01T00:00:00.000Z",
        }),
        makeDocument("newer", "Newer", {
          updatedAt: "2024-06-02T00:00:00.000Z",
        }),
      ];
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValue(makeListResponse(docs));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: baseConfig,
        credentials,
        checkpoint: {
          type: "outline" as const,
          lastSyncedAt: "2024-06-01T00:00:00.000Z",
        },
      })) {
        batches.push(batch);
      }

      const ids = batches.flatMap((b) => b.documents).map((d) => d.id);
      expect(ids).toEqual(["newer"]);
    });

    it("retries the collection without skip when the resume bookmark doc was deleted between runs", async () => {
      // Edge case: the doc whose id is persisted as `lastDocumentId` has been
      // deleted in Outline. Naive skip-scan would walk the whole collection
      // without finding the bookmark and drop every post-bookmark doc. The
      // retry fallback must detect the miss and re-scan from offset=0.
      const connector = new OutlineConnector();
      const col1Page = [
        makeDocument("doc-x", "X", { collectionId: "col-1" }),
        makeDocument("doc-y", "Y", { collectionId: "col-1" }),
        makeDocument("doc-z", "Z", { collectionId: "col-1" }),
      ];
      const fetchSpy = vi
        .spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValue(makeListResponse(col1Page));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...baseConfig, collectionIds: ["col-1"] },
        credentials,
        checkpoint: {
          type: "outline" as const,
          syncStart: "2024-07-15T12:00:00.000Z",
          lastCollectionId: "col-1",
          lastDocumentId: "doc-deleted",
        },
      })) {
        batches.push(batch);
      }

      const ingested = batches.flatMap((b) => b.documents).map((d) => d.id);
      // Skip pass fails to find the bookmark → retry scans from offset=0
      // and ingests everything in the collection.
      expect(ingested).toEqual(["doc-x", "doc-y", "doc-z"]);
      // One fetch for the skip pass, one for the retry pass.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("refuses to regress lastSyncedAt when the system clock goes backward between runs", async () => {
      // NTP skew or a container host change can leave Date.now() below the
      // previous run's lastSyncedAt. Without a clamp, a completed sweep would
      // persist a checkpoint lower than the prior one and cause the next run
      // to re-scan an already-confirmed window. We guard by clamping syncStart
      // so promotion never regresses.
      const previousLastSyncedAt = "2026-01-01T00:00:00.000Z";
      const clockRegressedTo = new Date("2025-06-01T00:00:00.000Z");

      vi.useFakeTimers();
      vi.setSystemTime(clockRegressedTo);
      try {
        const connector = new OutlineConnector();
        vi.spyOn(
          connector as unknown as SpyTarget,
          "fetchWithRetry",
        ).mockResolvedValue(makeListResponse([]));
        vi.spyOn(
          connector as unknown as SpyTarget,
          "rateLimit",
        ).mockResolvedValue(undefined);

        const batches: ConnectorSyncBatch[] = [];
        for await (const batch of connector.sync({
          config: baseConfig,
          credentials,
          checkpoint: {
            type: "outline" as const,
            lastSyncedAt: previousLastSyncedAt,
          },
        })) {
          batches.push(batch);
        }

        expect(batches.at(-1)?.checkpoint.lastSyncedAt).toBe(
          previousLastSyncedAt,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumes correctly when the bookmark doc lives on a later page", async () => {
      // Two-page collection: the bookmark is the last doc on page 1. The
      // skip phase spans the first page; processing starts on page 2 after
      // the bookmark transition.
      const connector = new OutlineConnector();
      const page1 = Array.from({ length: 25 }, (_, i) =>
        makeDocument(`p1-${i}`, `P1 ${i}`, { collectionId: "col-1" }),
      );
      const page2 = [
        makeDocument("p2-0", "P2 0", { collectionId: "col-1" }),
        makeDocument("p2-1", "P2 1", { collectionId: "col-1" }),
      ];

      vi.spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeListResponse(page1, { hasNextPath: true, limit: 25 }),
        )
        .mockResolvedValueOnce(
          makeListResponse(page2, { hasNextPath: false, limit: 25 }),
        );
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { ...baseConfig, collectionIds: ["col-1"] },
        credentials,
        checkpoint: {
          type: "outline" as const,
          syncStart: "2024-07-15T12:00:00.000Z",
          lastCollectionId: "col-1",
          lastDocumentId: "p1-24",
        },
      })) {
        batches.push(batch);
      }

      const ingested = batches.flatMap((b) => b.documents).map((d) => d.id);
      // Only page-2 docs are ingested — page 1 was fully pre-bookmark.
      expect(ingested).toEqual(["p2-0", "p2-1"]);
    });

    it("throws on non-OK API response during sync", async () => {
      const connector = new OutlineConnector();
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as unknown as Response);
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      await expect(async () => {
        for await (const _ of connector.sync({
          config: baseConfig,
          credentials,
          checkpoint: null,
        })) {
          // consume
        }
      }).rejects.toThrow(/Outline API error 500/);
    });
  });

  // ===== Permission sync =====

  type ContainerYield = Extract<PermissionSnapshotYield, { kind: "container" }>;
  type DocumentYield = Extract<PermissionSnapshotYield, { kind: "document" }>;

  type Route = {
    method: string;
    when?: (body: Record<string, unknown>) => boolean;
    body?: unknown;
    status?: number;
  };

  function installRoutes(connector: OutlineConnector, routes: Route[]) {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.spyOn(connector as unknown as SpyTarget, "rateLimit").mockResolvedValue(
      undefined,
    );
    vi.spyOn(
      connector as unknown as SpyTarget,
      "fetchWithRetry",
    ).mockImplementation(async (...args: unknown[]) => {
      const url = args[0] as string;
      const init = args[1] as { body?: string };
      const method = url.slice(url.indexOf("/api/") + "/api/".length);
      const body = init?.body
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
      calls.push({ method, body });
      const route = routes.find(
        (candidate) =>
          candidate.method === method &&
          (!candidate.when || candidate.when(body)),
      );
      if (!route) {
        throw new Error(`No route for ${method} ${JSON.stringify(body)}`);
      }
      if (route.status && route.status >= 400) {
        return {
          ok: false,
          status: route.status,
          json: async () => ({}),
          text: async () => "boom",
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => route.body,
        text: async () => "",
      } as unknown as Response;
    });
    return calls;
  }

  const envelope = (data: unknown, nextPath?: string) => ({
    ok: true,
    data,
    pagination: {
      limit: 100,
      offset: 0,
      ...(nextPath ? { nextPath } : {}),
    },
  });

  const apiUser = (
    id: string,
    email: string | null,
    opts?: { name?: string; role?: string; isSuspended?: boolean },
  ) => ({
    id,
    name: opts?.name ?? id,
    email,
    role: opts?.role ?? "member",
    isSuspended: opts?.isSuspended ?? false,
  });

  const authRoute = (team?: { id: string; name: string } | null): Route => ({
    method: "auth.info",
    body: {
      ok: true,
      data: {
        user: { id: "user-1", name: "Test User" },
        ...(team === null
          ? {}
          : { team: team ?? { id: "team-1", name: "Test Team" } }),
      },
    },
  });

  const noSharesRoute: Route = { method: "shares.list", body: envelope([]) };

  /**
   * Outline serializes `email` only where the endpoint asks for it, and the
   * membership endpoints do not: users nested in `collections.memberships`
   * and `groups.memberships` arrive email-less however privileged the key
   * is. Fixtures strip it so the suites exercise the real payload shape.
   */
  const withoutEmail = (users: ReturnType<typeof apiUser>[]) =>
    users.map(({ email: _email, ...rest }) => rest);

  /** `users.list` — the only endpoint that returns emails. */
  const directoryRoute = (users: ReturnType<typeof apiUser>[]): Route => ({
    method: "users.list",
    when: (body) => body.filter === "all",
    body: envelope(users),
  });

  /** `users.list` restricted to active members (workspace-default roster). */
  const activeUsersRoute = (users: ReturnType<typeof apiUser>[]): Route => ({
    method: "users.list",
    when: (body) => body.filter === "active",
    body: envelope(users),
  });

  const membershipsRoute = (
    collectionId: string,
    users: ReturnType<typeof apiUser>[],
  ): Route => ({
    method: "collections.memberships",
    when: (body) => body.id === collectionId,
    body: envelope({ users: withoutEmail(users), memberships: [] }),
  });

  const groupMembershipsRoute = (
    collectionId: string,
    groups: Array<{ id: string; name?: string }>,
  ): Route => ({
    method: "collections.group_memberships",
    when: (body) => body.id === collectionId,
    body: envelope({ groups, collectionGroupMemberships: [] }),
  });

  const collectionInfoRoute = (
    collectionId: string,
    permission: "read" | "read_write" | null,
  ): Route => ({
    method: "collections.info",
    when: (body) => body.id === collectionId,
    body: {
      ok: true,
      data: { id: collectionId, name: collectionId, permission },
    },
  });

  const ingested = (
    sourceId: string,
    collectionId: string,
    parentDocumentId: string | null = null,
  ) => ({
    sourceId,
    metadata: { collectionId, parentDocumentId, urlId: sourceId.slice(0, 8) },
  });

  const readBack = (docs: ReturnType<typeof ingested>[]) =>
    vi.fn(
      async (args: {
        metadataFilter?: Record<string, string>;
        afterId?: string | null;
        limit: number;
      }) => {
        const filtered = args.metadataFilter
          ? docs.filter((doc) =>
              Object.entries(
                args.metadataFilter as Record<string, string>,
              ).every(
                ([key, value]) =>
                  (doc.metadata as Record<string, unknown>)[key] === value,
              ),
            )
          : docs;
        const sorted = [...filtered].sort((a, b) =>
          a.sourceId.localeCompare(b.sourceId),
        );
        const start = args.afterId
          ? sorted.findIndex((doc) => doc.sourceId === args.afterId) + 1
          : 0;
        const page = sorted.slice(start, start + args.limit);
        return {
          documents: page,
          nextAfterId: page.length ? page[page.length - 1].sourceId : null,
        };
      },
    );

  function snapshotParams(overrides?: {
    config?: Record<string, unknown>;
    docs?: ReturnType<typeof ingested>[];
    cursor?: string | null;
    scope?: { containerKeys: string[] };
    resolveMappedEmail?: (externalAccountId: string) => string | null;
  }): PermissionSyncParams {
    return {
      config: overrides?.config ?? { ...baseConfig, collectionIds: ["col-1"] },
      credentials,
      cursor: overrides?.cursor ?? null,
      readIngestedDocuments: readBack(
        overrides?.docs ?? [
          ingested("doc-1", "col-1"),
          ingested("doc-2", "col-1"),
        ],
      ),
      ...(overrides?.scope ? { scope: overrides.scope } : {}),
      ...(overrides?.resolveMappedEmail
        ? { resolveMappedEmail: overrides.resolveMappedEmail }
        : {}),
    } as unknown as PermissionSyncParams;
  }

  async function collectSnapshot(gen: AsyncGenerator<PermissionSnapshotYield>) {
    const order: PermissionSnapshotYield[] = [];
    const containers = new Map<string, ContainerYield>();
    const documents: DocumentYield[] = [];
    for await (const item of gen) {
      order.push(item);
      if (item.kind === "container") containers.set(item.containerKey, item);
      else documents.push(item);
    }
    return { order, containers, documents };
  }

  describe("syncPermissionSnapshot", () => {
    it("resolves a private collection's audience from memberships and group memberships", async () => {
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        noSharesRoute,
        directoryRoute([
          apiUser("u-1", "Alice@Example.com"),
          apiUser("u-2", "bob@example.com"),
          apiUser("u-suspended", "sue@example.com", { isSuspended: true }),
          apiUser("u-hidden", null),
        ]),
        collectionInfoRoute("col-1", null),
        membershipsRoute("col-1", [
          apiUser("u-1", "Alice@Example.com"),
          apiUser("u-2", "bob@example.com"),
          apiUser("u-suspended", "sue@example.com", { isSuspended: true }),
          apiUser("u-hidden", null),
        ]),
        groupMembershipsRoute("col-1", [{ id: "grp-b" }, { id: "grp-a" }]),
      ]);

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(snapshotParams()),
      );

      const container = containers.get("collection:col-1");
      expect(container?.permissions).toEqual({
        isPublic: false,
        users: ["alice@example.com", "bob@example.com"],
        groups: ["grp-a", "grp-b"],
      });
      expect(container?.audienceResolutionFailed).toBe(false);
      expect(documents.map((doc) => doc.sourceId)).toEqual(["doc-1", "doc-2"]);
      expect(
        documents.every((doc) => doc.containerKey === "collection:col-1"),
      ).toBe(true);
      expect(documents.every((doc) => doc.cursor === "collection:col-1")).toBe(
        true,
      );
    });

    it("recovers a hidden email through resolveMappedEmail", async () => {
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        noSharesRoute,
        directoryRoute([apiUser("u-hidden", null)]),
        collectionInfoRoute("col-1", null),
        membershipsRoute("col-1", [apiUser("u-hidden", null)]),
        groupMembershipsRoute("col-1", []),
      ]);

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(
          snapshotParams({
            resolveMappedEmail: (id) =>
              id === "u-hidden" ? "Mapped@Example.com" : null,
          }),
        ),
      );

      expect(containers.get("collection:col-1")?.permissions.users).toEqual([
        "mapped@example.com",
      ]);
    });

    it("adds the workspace-scoped default group when the collection grants workspace-wide access", async () => {
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        noSharesRoute,
        directoryRoute([]),
        collectionInfoRoute("col-1", "read"),
        membershipsRoute("col-1", []),
        groupMembershipsRoute("col-1", []),
      ]);

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(snapshotParams()),
      );

      expect(containers.get("collection:col-1")?.permissions.groups).toEqual([
        "workspace-default-team-1",
      ]);
    });

    it("fail-closes the whole audience when a membership read fails, still yielding every document", async () => {
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        noSharesRoute,
        directoryRoute([]),
        collectionInfoRoute("col-1", "read"),
        {
          method: "collections.memberships",
          status: 500,
        },
        groupMembershipsRoute("col-1", [{ id: "grp-a" }]),
      ]);

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(snapshotParams()),
      );

      const container = containers.get("collection:col-1");
      expect(container?.permissions).toEqual({
        isPublic: false,
        users: [],
        groups: [],
      });
      expect(container?.audienceResolutionFailed).toBe(true);
      expect(documents.map((doc) => doc.sourceId)).toEqual(["doc-1", "doc-2"]);
    });

    it("emits an empty-corpus collection as a fail-closed boundary without resolving its audience", async () => {
      const connector = new OutlineConnector();
      const calls = installRoutes(connector, [
        authRoute(),
        noSharesRoute,
        directoryRoute([]),
      ]);

      const { containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(snapshotParams({ docs: [] })),
      );

      const container = containers.get("collection:col-1");
      expect(container?.permissions).toEqual({
        isPublic: false,
        users: [],
        groups: [],
      });
      expect(container?.audienceResolutionFailed).toBe(false);
      expect(documents).toEqual([]);
      expect(
        calls.filter((call) => call.method === "collections.info"),
      ).toEqual([]);
    });

    it("drains paginated membership listings before building the audience", async () => {
      const firstPage = Array.from({ length: 100 }, (_, i) =>
        apiUser(`u-${String(i).padStart(3, "0")}`, `user${i}@example.com`),
      );
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        noSharesRoute,
        directoryRoute([...firstPage, apiUser("u-last", "last@example.com")]),
        collectionInfoRoute("col-1", null),
        {
          method: "collections.memberships",
          when: (body) => body.offset === 0,
          body: {
            ok: true,
            data: { users: withoutEmail(firstPage), memberships: [] },
            pagination: { limit: 100, offset: 0, nextPath: "/api/next" },
          },
        },
        {
          method: "collections.memberships",
          when: (body) => body.offset === 100,
          body: envelope({
            users: withoutEmail([apiUser("u-last", "last@example.com")]),
            memberships: [],
          }),
        },
        groupMembershipsRoute("col-1", []),
      ]);

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(snapshotParams()),
      );

      expect(
        containers.get("collection:col-1")?.permissions.users,
      ).toHaveLength(101);
    });

    it("marks a collection public when a published collection share exists", async () => {
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        {
          method: "shares.list",
          body: envelope([
            {
              id: "s-1",
              collectionId: "col-1",
              documentId: null,
              published: true,
            },
            {
              id: "s-2",
              collectionId: "col-9",
              documentId: null,
              published: false,
            },
          ]),
        },
        directoryRoute([]),
        collectionInfoRoute("col-1", null),
        membershipsRoute("col-1", []),
        groupMembershipsRoute("col-1", []),
      ]);

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(snapshotParams()),
      );

      expect(containers.get("collection:col-1")?.permissions.isPublic).toBe(
        true,
      );
    });

    it("assigns published documents and their included children to the public nested container", async () => {
      const docs = [
        ingested("doc-child", "col-1", "doc-root"),
        ingested("doc-grandchild", "col-1", "doc-child"),
        ingested("doc-other", "col-1"),
        ingested("doc-solo", "col-1"),
      ];
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        {
          method: "shares.list",
          body: envelope([
            {
              id: "s-1",
              documentId: "doc-root",
              collectionId: null,
              published: true,
              includeChildDocuments: true,
            },
            {
              id: "s-2",
              documentId: "doc-solo",
              collectionId: null,
              published: true,
              includeChildDocuments: false,
            },
          ]),
        },
        directoryRoute([apiUser("u-1", "alice@example.com")]),
        collectionInfoRoute("col-1", null),
        membershipsRoute("col-1", [apiUser("u-1", "alice@example.com")]),
        groupMembershipsRoute("col-1", []),
      ]);

      const { order, containers, documents } = await collectSnapshot(
        connector.syncPermissionSnapshot(snapshotParams({ docs })),
      );

      const publicKey = "collection:col-1/public";
      expect(containers.get(publicKey)?.permissions).toEqual({
        isPublic: true,
        users: [],
        groups: [],
      });
      // The nested container is emitted before any document references it.
      const publicContainerIndex = order.findIndex(
        (item) => item.kind === "container" && item.containerKey === publicKey,
      );
      const firstPublicDocIndex = order.findIndex(
        (item) => item.kind === "document" && item.containerKey === publicKey,
      );
      expect(publicContainerIndex).toBeGreaterThan(-1);
      expect(publicContainerIndex).toBeLessThan(firstPublicDocIndex);

      const byId = new Map(documents.map((doc) => [doc.sourceId, doc]));
      expect(byId.get("doc-child")?.containerKey).toBe(publicKey);
      expect(byId.get("doc-grandchild")?.containerKey).toBe(publicKey);
      expect(byId.get("doc-solo")?.containerKey).toBe(publicKey);
      expect(byId.get("doc-other")?.containerKey).toBe("collection:col-1");
      // Nested yields still carry the TOP-LEVEL cursor.
      expect(
        [...containers.values(), ...documents].every(
          (item) => item.cursor === "collection:col-1",
        ),
      ).toBe(true);
    });

    it("degrades to no public shares when shares.list fails", async () => {
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        { method: "shares.list", status: 403 },
        directoryRoute([apiUser("u-1", "alice@example.com")]),
        collectionInfoRoute("col-1", null),
        membershipsRoute("col-1", [apiUser("u-1", "alice@example.com")]),
        groupMembershipsRoute("col-1", []),
      ]);

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(snapshotParams()),
      );

      const container = containers.get("collection:col-1");
      expect(container?.permissions.isPublic).toBe(false);
      expect(container?.permissions.users).toEqual(["alice@example.com"]);
      expect(container?.audienceResolutionFailed).toBe(false);
    });

    it("enumerates every visible collection sorted when no filter is configured", async () => {
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        noSharesRoute,
        directoryRoute([]),
        {
          method: "collections.list",
          body: envelope([{ id: "col-b" }, { id: "col-a" }]),
        },
        collectionInfoRoute("col-a", null),
        collectionInfoRoute("col-b", null),
        membershipsRoute("col-a", []),
        membershipsRoute("col-b", []),
        groupMembershipsRoute("col-a", []),
        groupMembershipsRoute("col-b", []),
      ]);

      const { order } = await collectSnapshot(
        connector.syncPermissionSnapshot(
          snapshotParams({
            config: baseConfig,
            docs: [ingested("doc-1", "col-a"), ingested("doc-2", "col-b")],
          }),
        ),
      );

      const containerKeys = order
        .filter((item) => item.kind === "container")
        .map((item) => item.containerKey);
      expect(containerKeys).toEqual(["collection:col-a", "collection:col-b"]);
    });

    it("skips containers before the cursor and outside the scope", async () => {
      const config = {
        ...baseConfig,
        collectionIds: ["col-a", "col-b", "col-c"],
      };
      const docs = [
        ingested("doc-1", "col-a"),
        ingested("doc-2", "col-b"),
        ingested("doc-3", "col-c"),
      ];
      const routes: Route[] = [
        authRoute(),
        noSharesRoute,
        directoryRoute([]),
        ...["col-a", "col-b", "col-c"].flatMap((id) => [
          collectionInfoRoute(id, null),
          membershipsRoute(id, []),
          groupMembershipsRoute(id, []),
        ]),
      ];

      const cursorConnector = new OutlineConnector();
      installRoutes(cursorConnector, routes);
      const cursorRun = await collectSnapshot(
        cursorConnector.syncPermissionSnapshot(
          snapshotParams({ config, docs, cursor: "collection:col-b" }),
        ),
      );
      expect([...cursorRun.containers.keys()]).toEqual([
        "collection:col-b",
        "collection:col-c",
      ]);

      const scopeConnector = new OutlineConnector();
      installRoutes(scopeConnector, routes);
      const scopedRun = await collectSnapshot(
        scopeConnector.syncPermissionSnapshot(
          snapshotParams({
            config,
            docs,
            scope: { containerKeys: ["collection:col-c"] },
          }),
        ),
      );
      expect([...scopedRun.containers.keys()]).toEqual(["collection:col-c"]);
    });

    it("grants individually-shared members whose membership payload carries no email", async () => {
      // Outline nests users in membership responses through a bare
      // presentUser(), which omits `email` for every caller. Reading the
      // email off that payload dropped every individual grantee, so a
      // collection shared with named people resolved to its groups alone.
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        noSharesRoute,
        directoryRoute([
          apiUser("u-margaret", "Margaret@example.com"),
          apiUser("u-mark", "mark@example.com"),
        ]),
        collectionInfoRoute("col-1", null),
        membershipsRoute("col-1", [
          apiUser("u-margaret", "Margaret@example.com"),
          apiUser("u-mark", "mark@example.com"),
        ]),
        groupMembershipsRoute("col-1", [{ id: "grp-eng" }]),
      ]);

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(snapshotParams()),
      );

      expect(containers.get("collection:col-1")?.permissions).toEqual({
        isPublic: false,
        users: ["margaret@example.com", "mark@example.com"],
        groups: ["grp-eng"],
      });
    });

    it("honors the directory's suspension state over the membership payload", async () => {
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        noSharesRoute,
        directoryRoute([
          apiUser("u-1", "alice@example.com"),
          apiUser("u-gone", "gone@example.com", { isSuspended: true }),
        ]),
        collectionInfoRoute("col-1", null),
        // The membership payload predates the suspension and omits the flag.
        membershipsRoute("col-1", [
          apiUser("u-1", "alice@example.com"),
          apiUser("u-gone", "gone@example.com"),
        ]),
        groupMembershipsRoute("col-1", []),
      ]);

      const { containers } = await collectSnapshot(
        connector.syncPermissionSnapshot(snapshotParams()),
      );

      expect(containers.get("collection:col-1")?.permissions.users).toEqual([
        "alice@example.com",
      ]);
    });

    it("fails the pass when auth.info returns no workspace id", async () => {
      const connector = new OutlineConnector();
      installRoutes(connector, [authRoute(null), noSharesRoute]);

      await expect(
        collectSnapshot(connector.syncPermissionSnapshot(snapshotParams())),
      ).rejects.toThrow(/no workspace id/);
    });
  });

  describe("syncGroups", () => {
    it("yields workspace groups, the workspace-default group, and the direct-grants roster", async () => {
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        directoryRoute([
          apiUser("u-1", "Alice@Example.com"),
          apiUser("u-2", "bob@example.com"),
          apiUser("u-3", "carol@example.com", { role: "viewer" }),
          apiUser("u-suspended", "sue@example.com", { isSuspended: true }),
          apiUser("u-guest", "guest@example.com", { role: "guest" }),
          apiUser("u-hidden", null),
        ]),
        {
          method: "groups.list",
          body: envelope({
            groups: [
              { id: "grp-b", name: "Beta" },
              { id: "grp-a", name: "Alpha" },
            ],
            groupMemberships: [],
          }),
        },
        {
          method: "groups.memberships",
          when: (body) => body.id === "grp-a",
          body: envelope({
            users: withoutEmail([
              apiUser("u-2", "bob@example.com"),
              apiUser("u-1", "Alice@Example.com"),
              apiUser("u-suspended", "sue@example.com", { isSuspended: true }),
            ]),
            groupMemberships: [],
          }),
        },
        {
          method: "groups.memberships",
          when: (body) => body.id === "grp-b",
          body: envelope({ users: [], groupMemberships: [] }),
        },
        activeUsersRoute([
          apiUser("u-1", "alice@example.com"),
          apiUser("u-3", "carol@example.com", { role: "viewer" }),
          apiUser("u-guest", "guest@example.com", { role: "guest" }),
        ]),
        membershipsRoute("col-1", [
          apiUser("u-1", "alice@example.com"),
          apiUser("u-hidden", null),
        ]),
      ]);

      const groups: GroupMembershipYield[] = [];
      for await (const group of connector.syncGroups(snapshotParams())) {
        groups.push(group);
      }

      expect(groups.map((group) => group.groupId)).toEqual([
        "grp-a",
        "grp-b",
        "workspace-default-team-1",
        "direct-grants",
      ]);
      const alpha = groups[0];
      expect(alpha.name).toBe("Alpha");
      expect(alpha.members.map((member) => member.accountId)).toEqual([
        "u-1",
        "u-2",
      ]);
      expect(alpha.members[0].email).toBe("alice@example.com");

      const defaults = groups[2];
      expect(defaults.name).toBe("Test Team default access");
      expect(defaults.members.map((member) => member.accountId)).toEqual([
        "u-1",
        "u-3",
      ]);

      const direct = groups[3];
      expect(direct.members.map((member) => member.accountId)).toEqual([
        "u-1",
        "u-hidden",
      ]);
      expect(direct.members[1].email).toBeNull();
    });

    it("resolves group and direct-grant roster emails through the directory", async () => {
      // Without the directory join every roster stored NULL emails, so no
      // Archestra user could ever match into a group — the group token was
      // in the ACL but granted nobody.
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        directoryRoute([
          apiUser("u-eng", "eng@example.com"),
          apiUser("u-direct", "direct@example.com"),
        ]),
        {
          method: "groups.list",
          body: envelope({
            groups: [{ id: "grp-eng", name: "Engineering" }],
            groupMemberships: [],
          }),
        },
        {
          method: "groups.memberships",
          when: (body) => body.id === "grp-eng",
          body: envelope({
            users: withoutEmail([apiUser("u-eng", "eng@example.com")]),
            groupMemberships: [],
          }),
        },
        activeUsersRoute([]),
        membershipsRoute("col-1", [apiUser("u-direct", "direct@example.com")]),
      ]);

      const groups: GroupMembershipYield[] = [];
      for await (const group of connector.syncGroups(snapshotParams())) {
        groups.push(group);
      }

      const engineering = groups.find((group) => group.groupId === "grp-eng");
      expect(engineering?.members[0].email).toBe("eng@example.com");
      const direct = groups.find((group) => group.groupId === "direct-grants");
      expect(direct?.members[0].email).toBe("direct@example.com");
    });

    it("throws instead of yielding a truncated roster when a group read fails", async () => {
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        directoryRoute([]),
        {
          method: "groups.list",
          body: envelope({
            groups: [{ id: "grp-a", name: "Alpha" }],
            groupMemberships: [],
          }),
        },
        { method: "groups.memberships", status: 500 },
      ]);

      await expect(async () => {
        for await (const _ of connector.syncGroups(snapshotParams())) {
          // consume
        }
      }).rejects.toThrow(/Outline API error 500/);
    });

    it("skips a collection whose membership read fails without losing the rest of the direct-grants roster", async () => {
      const connector = new OutlineConnector();
      installRoutes(connector, [
        authRoute(),
        directoryRoute([apiUser("u-1", "alice@example.com")]),
        {
          method: "groups.list",
          body: envelope({ groups: [], groupMemberships: [] }),
        },
        activeUsersRoute([]),
        {
          method: "collections.memberships",
          when: (body) => body.id === "col-a",
          status: 500,
        },
        membershipsRoute("col-b", [apiUser("u-1", "alice@example.com")]),
      ]);

      const groups: GroupMembershipYield[] = [];
      for await (const group of connector.syncGroups(
        snapshotParams({
          config: { ...baseConfig, collectionIds: ["col-a", "col-b"] },
        }),
      )) {
        groups.push(group);
      }

      const direct = groups.find((group) => group.groupId === "direct-grants");
      expect(direct?.members.map((member) => member.accountId)).toEqual([
        "u-1",
      ]);
    });
  });

  describe("scopeKeyForDocument", () => {
    it("maps collection metadata to the container key and everything else to null", () => {
      const connector = new OutlineConnector();
      expect(connector.scopeKeyForDocument({ collectionId: "col-1" })).toBe(
        "collection:col-1",
      );
      expect(connector.scopeKeyForDocument({ collectionId: null })).toBeNull();
      expect(connector.scopeKeyForDocument({ collectionId: "" })).toBeNull();
      expect(connector.scopeKeyForDocument({})).toBeNull();
    });
  });
});
