import { describe, expect, test } from "@/test";
import type {
  ConnectorSyncBatch,
  ConnectorType,
} from "@/types/knowledge-connector";
import { BaseConnector, buildCheckpoint } from "./base-connector";

/**
 * Concrete subclass that exposes protected methods for testing.
 */
class TestableConnector extends BaseConnector {
  type = "jira" as ConnectorType;

  async validateConfig() {
    return { valid: true };
  }
  async testConnection() {
    return { success: true };
  }
  async *sync(): AsyncGenerator<ConnectorSyncBatch> {
    // no-op
  }

  // Expose protected methods for testing
  public testJoinUrl(baseUrl: string, path: string): string {
    return this.joinUrl(baseUrl, path);
  }

  public testSafeItemFetch<T>(params: {
    fetch: () => Promise<T>;
    fallback: T;
    itemId: string | number;
    resource: string;
  }): Promise<T> {
    return this.safeItemFetch(params);
  }

  public testFlushFailures() {
    return this.flushFailures();
  }
}

describe("BaseConnector", () => {
  describe("joinUrl", () => {
    const connector = new TestableConnector();

    test("joins base URL without trailing slash", () => {
      expect(
        connector.testJoinUrl(
          "https://mycompany.atlassian.net",
          "rest/api/2/search",
        ),
      ).toBe("https://mycompany.atlassian.net/rest/api/2/search");
    });

    test("joins base URL with trailing slash", () => {
      expect(
        connector.testJoinUrl(
          "https://mycompany.atlassian.net/",
          "rest/api/2/search",
        ),
      ).toBe("https://mycompany.atlassian.net/rest/api/2/search");
    });

    test("joins base URL with multiple trailing slashes", () => {
      expect(
        connector.testJoinUrl(
          "https://mycompany.atlassian.net///",
          "rest/api/2/search",
        ),
      ).toBe("https://mycompany.atlassian.net/rest/api/2/search");
    });

    test("handles path with leading slash", () => {
      expect(
        connector.testJoinUrl(
          "https://mycompany.atlassian.net",
          "/rest/api/2/search",
        ),
      ).toBe("https://mycompany.atlassian.net/rest/api/2/search");
    });

    test("handles both trailing and leading slashes", () => {
      expect(
        connector.testJoinUrl(
          "https://mycompany.atlassian.net/",
          "/rest/api/2/search",
        ),
      ).toBe("https://mycompany.atlassian.net/rest/api/2/search");
    });

    test("produces identical results with and without trailing slash", () => {
      const withSlash = connector.testJoinUrl(
        "https://mycompany.atlassian.net/",
        "rest/api/2/search",
      );
      const withoutSlash = connector.testJoinUrl(
        "https://mycompany.atlassian.net",
        "rest/api/2/search",
      );
      expect(withSlash).toBe(withoutSlash);
    });
  });

  describe("safeItemFetch", () => {
    const connector = new TestableConnector();

    test("returns fetch result on success", async () => {
      const result = await connector.testSafeItemFetch({
        fetch: async () => [{ id: 1 }],
        fallback: [],
        itemId: 42,
        resource: "comments",
      });

      expect(result).toEqual([{ id: 1 }]);
      expect(connector.testFlushFailures()).toHaveLength(0);
    });

    test("returns fallback on error and records failure", async () => {
      const result = await connector.testSafeItemFetch({
        fetch: async () => {
          throw new Error("502 Bad Gateway");
        },
        fallback: [],
        itemId: 42,
        resource: "comments",
      });

      expect(result).toEqual([]);
      const failures = connector.testFlushFailures();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toEqual({
        itemId: 42,
        resource: "comments",
        error: "502 Bad Gateway",
      });
    });

    test("collects multiple failures", async () => {
      await connector.testSafeItemFetch({
        fetch: async () => {
          throw new Error("error 1");
        },
        fallback: "fallback",
        itemId: 1,
        resource: "comments",
      });
      await connector.testSafeItemFetch({
        fetch: async () => {
          throw new Error("error 2");
        },
        fallback: "fallback",
        itemId: 2,
        resource: "notes",
      });

      const failures = connector.testFlushFailures();
      expect(failures).toHaveLength(2);
      expect(failures[0].itemId).toBe(1);
      expect(failures[1].itemId).toBe(2);
    });
  });

  describe("flushFailures", () => {
    const connector = new TestableConnector();

    test("returns and clears failures", async () => {
      await connector.testSafeItemFetch({
        fetch: async () => {
          throw new Error("err");
        },
        fallback: null,
        itemId: 1,
        resource: "res",
      });

      const first = connector.testFlushFailures();
      expect(first).toHaveLength(1);

      const second = connector.testFlushFailures();
      expect(second).toHaveLength(0);
    });
  });

  describe("buildCheckpoint", () => {
    test("uses itemUpdatedAt when provided as ISO string", () => {
      const result = buildCheckpoint({
        type: "jira",
        itemUpdatedAt: "2024-06-20T15:30:00.000Z",
        previousLastSyncedAt: "2024-06-19T00:00:00.000Z",
      });

      expect(result.type).toBe("jira");
      expect(result.lastSyncedAt).toBe("2024-06-20T15:30:00.000Z");
    });

    test("uses itemUpdatedAt when provided as Date", () => {
      const result = buildCheckpoint({
        type: "github",
        itemUpdatedAt: new Date("2024-06-20T15:30:00.000Z"),
        previousLastSyncedAt: "2024-06-19T00:00:00.000Z",
      });

      expect(result.lastSyncedAt).toBe("2024-06-20T15:30:00.000Z");
    });

    test("falls back to previousLastSyncedAt when itemUpdatedAt is null", () => {
      const result = buildCheckpoint({
        type: "confluence",
        itemUpdatedAt: null,
        previousLastSyncedAt: "2024-06-19T00:00:00.000Z",
      });

      expect(result.lastSyncedAt).toBe("2024-06-19T00:00:00.000Z");
    });

    test("falls back to previousLastSyncedAt when itemUpdatedAt is undefined", () => {
      const result = buildCheckpoint({
        type: "gitlab",
        itemUpdatedAt: undefined,
        previousLastSyncedAt: "2024-06-19T00:00:00.000Z",
      });

      expect(result.lastSyncedAt).toBe("2024-06-19T00:00:00.000Z");
    });

    test("returns undefined lastSyncedAt when both are missing", () => {
      const result = buildCheckpoint({
        type: "github",
        itemUpdatedAt: null,
        previousLastSyncedAt: undefined,
      });

      expect(result.lastSyncedAt).toBeUndefined();
    });

    test("spreads extra fields into checkpoint", () => {
      const result = buildCheckpoint({
        type: "jira",
        itemUpdatedAt: "2024-06-20T15:30:00.000Z",
        previousLastSyncedAt: undefined,
        extra: { lastIssueKey: "PROJ-42" },
      });

      expect(result).toEqual({
        type: "jira",
        lastSyncedAt: "2024-06-20T15:30:00.000Z",
        lastIssueKey: "PROJ-42",
      });
    });

    test("works without extra fields", () => {
      const result = buildCheckpoint({
        type: "gitlab",
        itemUpdatedAt: "2024-06-20T15:30:00.000Z",
        previousLastSyncedAt: undefined,
      });

      expect(result).toEqual({
        type: "gitlab",
        lastSyncedAt: "2024-06-20T15:30:00.000Z",
      });
    });
  });
});
