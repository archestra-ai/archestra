import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { ConnectorSyncBatch } from "@/types";
import { NotionConnector } from "./notion-connector";

describe("NotionConnector", () => {
  let connector: NotionConnector;

  const validConfig = {
    type: "notion" as const,
    databaseIds: ["db-1"],
    pageIds: ["page-1"],
  };

  const credentials = {
    apiToken: "secret_test_token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new NotionConnector();
    // Mock fetchWithRetry since BaseConnector uses it
    // @ts-ignore - mock private method for testing
    vi.spyOn(connector, "fetchWithRetry").mockImplementation(async (url: string, options: any) => {
      if (url.includes("/v1/users/me")) {
        return { ok: true, json: async () => ({ id: "user-1" }) } as Response;
      }
      if (url.includes("/v1/search")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                object: "page",
                id: "page-123",
                url: "https://notion.so/page-123",
                last_edited_time: "2024-01-15T10:00:00.000Z",
                properties: {
                  title: { type: "title", title: [{ plain_text: "Test Page" }] }
                }
              }
            ],
            has_more: false,
            next_cursor: null
          })
        } as Response;
      }
      if (url.includes("/children")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "Hello World", annotations: {} }] },
                has_children: false
              }
            ],
            has_more: false
          })
        } as Response;
      }
      return { ok: false, statusText: "Not Found" } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("validateConfig", () => {
    test("returns valid for correct config", async () => {
      const result = await connector.validateConfig(validConfig);
      expect(result).toEqual({ valid: true });
    });

    test("returns valid for empty filters", async () => {
      const result = await connector.validateConfig({ type: "notion" });
      expect(result).toEqual({ valid: true });
    });

    test("returns invalid for incorrect types", async () => {
      // @ts-ignore - testing runtime validation
      const result = await connector.validateConfig({ type: "notion", databaseIds: "not-an-array" });
      expect(result.valid).toBe(false);
    });
  });

  describe("testConnection", () => {
    test("returns success when API responds OK", async () => {
      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });
      expect(result).toEqual({ success: true });
    });

    test("returns error when API fails", async () => {
      // @ts-ignore
      vi.spyOn(connector, "fetchWithRetry").mockResolvedValueOnce({
        ok: false,
        json: async () => ({ message: "Unauthorized" }),
      });

      const result = await connector.testConnection({
        config: validConfig,
        credentials,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unauthorized");
    });
  });

  describe("sync", () => {
    test("yields documents from search results", async () => {
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { type: "notion" },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toBe("Test Page");
      expect(batches[0].documents[0].content).toContain("Hello World");
    });

    test("incremental sync skips older items", async () => {
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { type: "notion" },
        credentials,
        checkpoint: { type: "notion", lastSyncedAt: "2024-01-20T00:00:00.000Z" },
      })) {
        batches.push(batch);
      }

      // The mock returns an item from 2024-01-15, which is before the checkpoint
      expect(batches[0].documents).toHaveLength(0);
    });

    test("block to markdown conversion", async () => {
      // @ts-ignore
      vi.spyOn(connector, "fetchWithRetry").mockImplementation(async (url: string) => {
        if (url.includes("/v1/search")) {
          return {
            ok: true,
            json: async () => ({
              results: [{
                object: "page", id: "p1", last_edited_time: "2024-01-01T00:00:00Z",
                properties: { Name: { type: "title", title: [{ plain_text: "Markdown Test" }] } }
              }],
              has_more: false
            })
          } as Response;
        }
        if (url.includes("/children")) {
          return {
            ok: true,
            json: async () => ({
              results: [
                { type: "heading_1", heading_1: { rich_text: [{ plain_text: "H1", annotations: {} }] } },
                { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Bullet", annotations: { bold: true } }] } },
                { type: "code", code: { language: "typescript", rich_text: [{ plain_text: "const x = 1;", annotations: {} }] } }
              ],
              has_more: false
            })
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      });

      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({ config: { type: "notion" }, credentials, checkpoint: null })) {
        batches.push(batch);
      }

      const content = batches[0].documents[0].content;
      expect(content).toContain("# H1");
      expect(content).toContain("* **Bullet**");
      expect(content).toContain("```typescript\nconst x = 1;\n```");
    });
  });
});
