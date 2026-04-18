import { describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
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
  it("has the correct type", () => {
    const connector = new OutlineConnector();
    expect(connector.type).toBe("outline");
  });

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

    it("stops early when documents are older than the checkpoint", async () => {
      const connector = new OutlineConnector();
      const checkpoint = {
        type: "outline" as const,
        lastSyncedAt: "2024-06-01T00:00:00.000Z",
      };

      // Results sorted DESC: first doc is recent, second is old (before checkpoint)
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
      ).mockResolvedValue(makeListResponse(docs, { hasNextPath: true }));
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
      // Only the new doc should be included; old doc was filtered out
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("doc-new");
      // hasMore should be false because we stopped early
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

    it("uses checkpoint lastSyncedAt in subsequent syncs", async () => {
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

      expect(batches[0].checkpoint.lastSyncedAt).toBe(
        "2024-06-15T00:00:00.000Z",
      );
    });

    it("preserves previous checkpoint when no documents are returned", async () => {
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

      expect(batches[0].checkpoint.lastSyncedAt).toBe(
        "2024-06-01T00:00:00.000Z",
      );
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
});
