import { describe, expect, test } from "vitest";
import { NotionConnector } from "./notion-connector";

describe("NotionConnector", () => {
  test("type is notion", () => {
    const connector = new NotionConnector();
    expect(connector.type).toBe("notion");
  });

  describe("validateConfig", () => {
    test("accepts valid config with notionApiUrl", async () => {
      const connector = new NotionConnector();
      const result = await connector.validateConfig({
        notionApiUrl: "https://api.notion.com",
      });
      expect(result).toEqual({ valid: true });
    });

    test("accepts config with database IDs", async () => {
      const connector = new NotionConnector();
      const result = await connector.validateConfig({
        notionApiUrl: "https://api.notion.com",
        databaseIds: ["db-1", "db-2"],
      });
      expect(result).toEqual({ valid: true });
    });

    test("accepts config with page IDs", async () => {
      const connector = new NotionConnector();
      const result = await connector.validateConfig({
        notionApiUrl: "https://api.notion.com",
        pageIds: ["page-1"],
      });
      expect(result).toEqual({ valid: true });
    });

    test("accepts config with batch size", async () => {
      const connector = new NotionConnector();
      const result = await connector.validateConfig({
        notionApiUrl: "https://api.notion.com",
        batchSize: 100,
      });
      expect(result).toEqual({ valid: true });
    });

    test("rejects config without notionApiUrl", async () => {
      const connector = new NotionConnector();
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    test("prepends https to URLs without protocol", async () => {
      const connector = new NotionConnector();
      const result = await connector.validateConfig({
        notionApiUrl: "api.notion.com",
      });
      expect(result).toEqual({ valid: true });
    });
  });
});
