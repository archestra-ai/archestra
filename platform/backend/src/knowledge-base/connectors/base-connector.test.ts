import { describe, expect, test } from "@/test";
import type {
  ConnectorSyncBatch,
  ConnectorType,
} from "@/types/knowledge-connector";
import { BaseConnector } from "./base-connector";

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
});
