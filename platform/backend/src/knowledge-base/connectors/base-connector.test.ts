import { describe, expect, test } from "@/test";
import type {
  ConnectorSyncBatch,
  ConnectorType,
} from "@/types/knowledge-connector";
import { BaseConnector, buildCheckpoint } from "./base-connector";

/**
 * Concrete subclass that exposes the protected `joinUrl` method for testing.
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

  // Expose protected method for testing
  public testJoinUrl(baseUrl: string, path: string): string {
    return this.joinUrl(baseUrl, path);
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
